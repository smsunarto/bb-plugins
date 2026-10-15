import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
} from "@get-bb/plugin-sdk/testing";
import { EditorClaims } from "./unity-editor-store.ts";
import { SlotStore } from "./slot-store.ts";
import { importUnityStorage, ensureUnityStorage } from "./unity-storage-migration.ts";
import plugin from "../server.ts";
import { project } from "./unity-slots-test-fixture.ts";
import { legacyClaimsGuard } from "./legacy-claims.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const instance = {
  id: "main",
  projectPath: "/game",
  workspacePath: "/game",
  pid: 101,
  port: 7800,
  version: "6000.3.10f1",
  startedAt: "birth",
  clone: false,
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "studio-unity-migration-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "plugins/unity"), { recursive: true });
  const source = new Database(join(dir, "plugins/unity/data.db"));
  const target = new Database(":memory:");
  cleanups.push(
    () => source.close(),
    () => target.close(),
  );
  for (const db of [source, target]) {
    void new SlotStore(db);
    void new EditorClaims(db);
    db.exec(
      "CREATE TABLE unity_editor_migrations (id TEXT PRIMARY KEY); CREATE TABLE unity_slot_seeds (operation TEXT PRIMARY KEY, slot TEXT NOT NULL, result TEXT NOT NULL)",
    );
  }
  return { dir, source, target };
}

test("namespace migration preserves claims, leases, receipts, and completed legacy handoff exactly once", () => {
  const { dir, source, target } = setup();
  const slots = new SlotStore(source);
  const slot = slots.register("host", "/game", "project");
  const lease = slots.acquire(slot.id, "host", "project", "alice");
  slots.completeAcquire(slot.id, lease.leaseId!);
  const claims = new EditorClaims(source, slots);
  const claim = claims.claim("host", instance, "alice", "authoring").claim;
  claims.job("host", instance.id, "alice", claim.claimId, "native-job");
  source
    .prepare("INSERT INTO unity_slot_seeds VALUES (?,?,?)")
    .run("operation", slot.id, '{"cacheSeed":"copy-on-write"}');
  source.prepare("INSERT INTO unity_editor_migrations VALUES (?)").run("kitchen-sink-v1");
  importUnityStorage(target, dir);
  const migrated = new EditorClaims(target);
  expect(migrated.get("host", "main")).toEqual({ ...claim, jobId: "native-job" });
  expect(new SlotStore(target).get(slot.id)).toEqual(slots.get(slot.id));
  expect(target.prepare("SELECT * FROM unity_slot_seeds").all()).toEqual([
    { operation: "operation", slot: slot.id, result: '{"cacheSeed":"copy-on-write"}' },
  ]);
  expect(() => migrated.claim("host", instance, "bob", "authoring")).toThrow(
    "owned by @thread:alice",
  );
  migrated.job("host", "main", "alice", claim.claimId, null);
  migrated.release("host", "main", "alice", claim.claimId);
  importUnityStorage(target, dir);
  expect(migrated.get("host", "main")).toBeNull();
  expect(claims.get("host", "main")?.jobId).toBe("native-job");
  expect(target.prepare("SELECT id FROM unity_editor_migrations ORDER BY id").all()).toEqual([
    { id: "kitchen-sink-v1" },
    { id: "unity-plugin-v1" },
  ]);
});

test("interrupted submissions and checkout preparations retain exclusion after migration", () => {
  const { dir, source, target } = setup();
  const slots = new SlotStore(source);
  const slot = slots.register("host", "/game", "project");
  const lease = slots.acquire(slot.id, "host", "project", "alice");
  slots.completeAcquire(slot.id, lease.leaseId!);
  const claims = new EditorClaims(source, slots);
  const claim = claims.claim("host", instance, "alice", "authoring").claim;
  claims.job("host", "main", "alice", claim.claimId, null);
  claims.begin("host", "main", "alice", claim.claimId);
  const other = slots.register("host", "/partial", "project");
  const pending = slots.acquire(other.id, "host", "project", "alice");
  importUnityStorage(target, dir);
  expect(new EditorClaims(target).get("host", "main")?.jobId).toBe("uncertain");
  const migrated = new SlotStore(target).get(other.id)!;
  expect(migrated.state).toBe("quarantined");
  expect(migrated.leaseId).toBe(pending.leaseId);
  expect(migrated.ownerThreadId).toBe("alice");
});

test("a conflicting target rolls the entire import back without a migration receipt", () => {
  const { dir, source, target } = setup();
  new SlotStore(source).register("host", "/game", "project");
  new SlotStore(target).register("host", "/game", "project");
  expect(() => importUnityStorage(target, dir)).toThrow();
  expect(target.prepare("SELECT id FROM unity_editor_migrations").all()).toEqual([]);
  target.prepare("DELETE FROM unity_checkout_slots").run();
  importUnityStorage(target, dir);
  expect(new SlotStore(target).list()).toHaveLength(1);
});

test("the standalone manager cannot run alongside Game Studio even after legacy claims migrated", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [{ id: "unity", enabled: true, status: "running" }] as never,
        }),
      },
    },
  });
  const db = bb.storage.database();
  void new EditorClaims(db);
  const ready = legacyClaimsGuard(bb, db);
  db.prepare("INSERT INTO unity_editor_migrations VALUES (?)").run("kitchen-sink-v1");
  await expect(ready()).rejects.toThrow("Disable the separate Unity plugin");
  await expect(ensureUnityStorage(bb, db)).rejects.toThrow("Disable the separate Unity plugin");
  await harness.lifecycle.dispose();
});

async function coldHost(blocked = false) {
  const f = setup();
  const slots = new SlotStore(f.source);
  const slot = slots.register("host", "/game", "project");
  const lease = slots.acquire(slot.id, "host", "project", "alice");
  slots.completeAcquire(slot.id, lease.leaseId!);
  f.source.prepare("INSERT INTO unity_editor_migrations VALUES (?)").run("kitchen-sink-v1");
  const host = createFakePluginHost({
    pluginId: "game-studio",
    dataDir: f.dir,
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [
            { id: "unity", enabled: blocked, status: blocked ? "running" : "disabled" },
          ] as never,
        }),
      },
    },
    experimental_callHostRpc: ({ method, input }) => {
      if (method === "resolveWorkspace") return { workspacePath: (input as { path: string }).path };
      throw new Error("No Unity control or workspace modification is expected");
    },
  });
  await plugin(host.bb);
  return { ...host, slot };
}

test("the first message after upgrade imports leases before admitting another checkout owner", async () => {
  const { harness } = await coldHost();
  try {
    const dispatch = harness.registrations.hooks["message.dispatch"]!;
    const decision = await dispatch(
      makeMessageDispatchHookContext({
        thread: { id: "bob", projectId: "project", environmentId: "environment" },
        project,
        host: makeHostResponse({ id: "host" }),
        environment: { id: "environment", hostId: "host", path: "/game", projectId: "project" },
      }),
    );
    expect(decision).toMatchObject({
      action: "reject",
      message: expect.stringContaining("@thread:alice"),
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("provider validation imports existing slots before the first tool or inventory request", async () => {
  const { harness, slot } = await coldHost();
  try {
    const provider = harness.registrations.environmentProviders.get("unity-rampage-slot")!;
    expect(
      await provider.validate!({
        inputs: { slotId: slot.id },
        host: makeHostResponse({ id: "host" }),
        project,
        projectCheckout: { path: "/game", experimental_ownsPath: false },
        gitRemote: null,
      }),
    ).toEqual({ action: "accept" });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("unavailable migration fails closed for message admission and provider validation", async () => {
  const { harness, slot } = await coldHost(true);
  try {
    const dispatch = harness.registrations.hooks["message.dispatch"]!;
    expect(
      await dispatch(
        makeMessageDispatchHookContext({ environment: { hostId: "host", path: "/game" } }),
      ),
    ).toMatchObject({
      action: "reject",
      message: expect.stringContaining("Disable the separate Unity plugin"),
    });
    const provider = harness.registrations.environmentProviders.get("unity-rampage-slot")!;
    expect(
      await provider.validate!({
        inputs: { slotId: slot.id },
        host: makeHostResponse({ id: "host" }),
        project,
        projectCheckout: { path: "/game", experimental_ownsPath: false },
        gitRemote: null,
      }),
    ).toMatchObject({
      action: "refuse",
      message: expect.stringContaining("Disable the separate Unity plugin"),
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("unrelated and projectless messages proceed while the old Unity manager remains enabled", async () => {
  const { harness } = await coldHost(true);
  try {
    const dispatch = harness.registrations.hooks["message.dispatch"]!;
    expect(
      await dispatch(
        makeMessageDispatchHookContext({ environment: null, environmentIntent: null }),
      ),
    ).toEqual({ action: "proceed" });
    expect(
      await dispatch(
        makeMessageDispatchHookContext({ environment: { hostId: "host", path: "/other-project" } }),
      ),
    ).toEqual({ action: "proceed" });
    expect(
      await dispatch(
        makeMessageDispatchHookContext({ environment: { hostId: "other-host", path: "/game" } }),
      ),
    ).toEqual({ action: "proceed" });
    expect(
      await dispatch(
        makeMessageDispatchHookContext({ environment: { hostId: "host", path: "/game" } }),
      ),
    ).toMatchObject({
      action: "reject",
      message: expect.stringContaining("Disable the separate Unity plugin"),
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("slot-provider dispatch fails closed before any path is assigned when migration is unavailable", async () => {
  const { harness } = await coldHost(true);
  try {
    const dispatch = harness.registrations.hooks["message.dispatch"]!;
    expect(
      await dispatch(
        makeMessageDispatchHookContext({
          environment: null,
          environmentIntent: {
            kind: "provider",
            environmentProviderId: "unity-rampage-slot",
            machine: { type: "existing", hostId: "host" },
            inputs: {},
          },
        }),
      ),
    ).toMatchObject({
      action: "reject",
      message: expect.stringContaining("Disable the separate Unity plugin"),
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});
