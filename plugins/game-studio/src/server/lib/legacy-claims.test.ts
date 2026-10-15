import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { type EditorClaim, EditorClaims } from "./unity-editor-store.ts";
import { legacyClaimsGuard } from "./legacy-claims.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
const claim: EditorClaim = {
  instance: {
    id: "main",
    projectPath: "/game",
    workspacePath: "/game",
    pid: 101,
    port: 7800,
    version: "6000.3.10f1",
    startedAt: "birth",
    clone: false,
  },
  hostId: "host",
  ownerThreadId: "alice",
  claimId: "existing-claim",
  mode: "authoring",
  jobId: "native-job",
  claimedAt: "2026-10-11T00:00:00Z",
  orphaned: true,
};
function setup(records: string[], disabled = false) {
  let exports = 0;
  const { bb } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [
            { id: "kitchen-sink", enabled: !disabled, status: disabled ? "disabled" : "running" },
          ],
        }),
        callRpc: async () => {
          exports++;
          return { version: 1, claims: records };
        },
      },
    },
  });
  const db = bb.storage.database();
  disposers.push(() => db.close());
  const store = new EditorClaims(db);
  return { bb, db, store, records, exports: () => exports };
}

test("handoff preserves an occupied Editor, owner capability and native job across reload", async () => {
  const f = setup([JSON.stringify(claim)]);
  await legacyClaimsGuard(f.bb, f.db)();
  expect(f.store.get("host", "main")).toEqual(claim);
  expect(() => f.store.claim("host", claim.instance, "bob", "authoring")).toThrow(
    "owned by @thread:alice",
  );
  await legacyClaimsGuard(f.bb, f.db)();
  expect(f.exports()).toBe(1);
  expect(f.store.get("host", "main")?.jobId).toBe("native-job");
});

test("a completed import never resurrects a subsequently released claim", async () => {
  const f = setup([JSON.stringify({ ...claim, jobId: null })]);
  await legacyClaimsGuard(f.bb, f.db)();
  f.store.release("host", "main", "alice", "existing-claim");
  await legacyClaimsGuard(f.bb, f.db)();
  const next = f.store.claim("host", claim.instance, "bob", "authoring").claim;
  expect(next.ownerThreadId).toBe("bob");
  expect(next.claimId).not.toBe("existing-claim");
  expect(f.exports()).toBe(1);
});

test("interrupted submissions stay uncertain while read-only verification is discarded", async () => {
  const f = setup([
    JSON.stringify({ ...claim, jobId: "submitting" }),
    JSON.stringify({ ...claim, instance: { ...claim.instance, id: "probe" }, jobId: "verifying" }),
  ]);
  await legacyClaimsGuard(f.bb, f.db)();
  expect(f.store.list("host").map((entry) => [entry.instance.id, entry.jobId])).toEqual([
    ["main", "uncertain"],
  ]);
  expect(() => f.store.release("host", "main", "alice", "existing-claim")).toThrow(
    "pending or uncertain",
  );
});

test("a malformed snapshot rolls back and a repaired retry imports every claim once", async () => {
  const f = setup([JSON.stringify(claim), "invalid JSON"]);
  const ready = legacyClaimsGuard(f.bb, f.db);
  await expect(ready()).rejects.toThrow("migration is incomplete");
  expect(f.store.get("host", "main")).toBeNull();
  f.records.pop();
  await ready();
  expect(f.store.get("host", "main")?.claimId).toBe("existing-claim");
  expect(f.exports()).toBe(2);
});

test("a disabled legacy owner cannot be mistaken for an empty claim store", async () => {
  const f = setup([JSON.stringify(claim)], true);
  await expect(legacyClaimsGuard(f.bb, f.db)()).rejects.toThrow("migration is incomplete");
  expect(f.exports()).toBe(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM unity_editor_migrations").get()).toEqual({ n: 0 });
});

test("renaming preserves current claims and does not reimport stale Kitchen Sink ownership", async () => {
  const lookups: string[] = [];
  const { bb } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [
            { id: "unity-editors", enabled: true, status: "running" },
            { id: "kitchen-sink", enabled: true, status: "running" },
          ],
        }),
        callRpc: async ({ pluginId }: { pluginId: string }) => {
          lookups.push(pluginId);
          if (pluginId !== "unity-editors")
            throw new Error("Stale Kitchen Sink claims must not be reimported");
          return {
            version: 1,
            claims: [JSON.stringify({ ...claim, jobId: null })],
            migratedKitchenSink: true,
          };
        },
      },
    },
  });
  const db = bb.storage.database();
  disposers.push(() => db.close());
  const store = new EditorClaims(db);
  await legacyClaimsGuard(bb, db)();
  expect(store.get("host", "main")?.claimId).toBe("existing-claim");
  store.release("host", "main", "alice", "existing-claim");
  await legacyClaimsGuard(bb, db)();
  expect(store.claim("host", claim.instance, "bob", "authoring").claim.ownerThreadId).toBe("bob");
  expect(lookups).toEqual(["unity-editors"]);
});

test("an unused old namespace still transfers the original Kitchen Sink claim store", async () => {
  const { bb } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [
            { id: "unity-editors", enabled: true, status: "running" },
            { id: "kitchen-sink", enabled: true, status: "running" },
          ],
        }),
        callRpc: async ({ pluginId }: { pluginId: string }) =>
          pluginId === "unity-editors"
            ? { version: 1, claims: [], migratedKitchenSink: false }
            : { version: 1, claims: [JSON.stringify(claim)] },
      },
    },
  });
  const db = bb.storage.database();
  disposers.push(() => db.close());
  const store = new EditorClaims(db);
  await legacyClaimsGuard(bb, db)();
  expect(store.get("host", "main")).toEqual(claim);
});
