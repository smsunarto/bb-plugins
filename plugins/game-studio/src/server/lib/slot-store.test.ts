import { afterEach, expect, test } from "bun:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlotStore } from "./slot-store.ts";
import { EditorClaims } from "./unity-editor-store.ts";
import { checkoutSlots } from "./checkout-slots.ts";
import type { EditorInstance } from "../../shared/unity-editor-contract.ts";

const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(path = ":memory:") {
  const db = new Database(path);
  dbs.push(db);
  return db;
}

function setup() {
  const db = database();
  const claims = new EditorClaims(db);
  const store = new SlotStore(db);
  const slot = store.register("host", "/rampage", "project");
  return { db, claims, store, slot };
}

function acquire(store: SlotStore, id: string, owner = "alice") {
  const reservation = store.acquire(id, "host", "project", owner);
  return store.completeAcquire(id, reservation.leaseId!);
}

const editor: EditorInstance = {
  id: "main",
  projectPath: "/rampage",
  workspacePath: "/rampage",
  pid: 101,
  port: 7800,
  version: "6000.3.10f1",
  startedAt: "birth",
  clone: false,
};

test("registration preserves inventory identity, host scope, and explicit retired re-adoption", () => {
  const { store, slot } = setup();
  expect(slot.id).toBe(checkoutSlots("host", [editor], [])[0]!.id);
  expect(store.register("host", "/rampage", "project")).toEqual(slot);
  expect(store.register("other-host", "/rampage", "project").id).not.toBe(slot.id);
  expect(store.register("host", "/rampage-other", "project").id).not.toBe(slot.id);
  expect(store.list("host").map((entry) => entry.workspacePath)).toEqual([
    "/rampage",
    "/rampage-other",
  ]);
  expect(() => store.register("host", "/rampage", "another-project")).toThrow("BB project");
  const retiring = store.beginRetire(slot.id, "host", "/rampage");
  const retired = store.completeRetire(slot.id, retiring.leaseId!);
  expect(retired.state).toBe("retired");
  expect(() => store.acquire(slot.id, "host", "project", "alice")).toThrow("retired");
  expect(store.register("host", "/rampage", "project").state).toBe("available");
});

test("two connections cannot lease the same checkout and a repeat lease keeps its token", () => {
  const dir = mkdtempSync(join(tmpdir(), "unity-slot-store-"));
  dirs.push(dir);
  const first = new SlotStore(database(join(dir, "claims.db")));
  const second = new SlotStore(database(join(dir, "claims.db")));
  const slot = first.register("host", "/rampage", "project");
  const reservation = first.acquire(slot.id, "host", "project", "alice");
  expect(reservation.state).toBe("preparing");
  expect(() => second.acquire(slot.id, "host", "project", "alice")).toThrow("preparing");
  expect(() => second.acquire(slot.id, "host", "project", "bob")).toThrow("@thread:alice");
  expect(() => second.editorAccess("host", "/rampage", "alice")).toThrow("preparing");
  const lease = first.completeAcquire(slot.id, reservation.leaseId!);
  expect(first.completeAcquire(slot.id, reservation.leaseId!)).toEqual(lease);
  expect(second.acquire(slot.id, "host", "project", "alice")).toEqual(lease);
  expect(() => second.acquire(slot.id, "host", "project", "bob")).toThrow("@thread:alice");
  expect(() => second.acquire(slot.id, "other-host", "project", "alice")).toThrow("host");
  expect(() => second.acquire(slot.id, "host", "other-project", "alice")).toThrow("BB project");
  expect(second.find("host", "/rampage")?.leaseId).toBe(lease.leaseId);
});

test("release keeps exclusion during host checks and stale completion cannot free a newer lease", () => {
  const { store, slot } = setup();
  const lease = acquire(store, slot.id);
  const releasing = store.beginRelease(slot.id, "alice", lease.leaseId!);
  expect(releasing.state).toBe("releasing");
  expect(store.beginRelease(slot.id, "alice", lease.leaseId!)).toEqual(releasing);
  expect(() => store.acquire(slot.id, "host", "project", "bob")).toThrow("releasing");
  expect(() => store.editorAccess("host", "/rampage", "alice")).toThrow("releasing");
  expect(store.completeRelease(slot.id, lease.leaseId!).state).toBe("available");
  expect(store.completeRelease(slot.id, lease.leaseId!).state).toBe("available");
  const next = acquire(store, slot.id, "bob");
  expect(next.leaseId).not.toBe(lease.leaseId);
  expect(() => store.completeRelease(slot.id, lease.leaseId!)).toThrow("changed");
  expect(() => store.quarantine(slot.id, lease.leaseId!, "late failure")).toThrow("changed");
  expect(store.get(slot.id)?.ownerThreadId).toBe("bob");
});

test("reload retains ordinary leases and quarantines interrupted release without forgetting its owner", () => {
  const { db, store, slot } = setup();
  const lease = acquire(store, slot.id);
  expect(new SlotStore(db).get(slot.id)).toEqual(lease);
  store.beginRelease(slot.id, "alice", lease.leaseId!);
  const reloaded = new SlotStore(db);
  const quarantined = reloaded.get(slot.id)!;
  expect([quarantined.state, quarantined.ownerThreadId, quarantined.leaseId]).toEqual([
    "quarantined",
    "alice",
    lease.leaseId,
  ]);
  expect(quarantined.reason).toContain("interrupted");
  expect(() => reloaded.acquire(slot.id, "host", "project", "bob")).toThrow("quarantined");
  expect(() => store.completeRelease(slot.id, lease.leaseId!)).toThrow("changed");
});

test("interrupted preparation stays unavailable until explicit recovery verifies its new token", () => {
  const { db, store, slot } = setup();
  const reservation = store.acquire(slot.id, "host", "project", "alice");
  const reloaded = new SlotStore(db);
  expect(reloaded.get(slot.id)?.state).toBe("quarantined");
  expect(() => store.completeAcquire(slot.id, reservation.leaseId!)).toThrow("changed");
  expect(() => reloaded.editorAccess("host", "/rampage", "alice")).toThrow("quarantined");
  const recovery = reloaded.beginRecovery(slot.id, reservation.leaseId);
  expect(recovery.leaseId).not.toBe(reservation.leaseId);
  expect(reloaded.completeRelease(slot.id, recovery.leaseId!).state).toBe("available");
  const next = acquire(reloaded, slot.id, "bob");
  expect(() => store.completeAcquire(slot.id, reservation.leaseId!)).toThrow("changed");
  expect(reloaded.get(slot.id)?.leaseId).toBe(next.leaseId);
});

test("explicit recovery rotates its operation token before host verification", () => {
  const { store, slot } = setup();
  const lease = acquire(store, slot.id);
  store.quarantine(slot.id, lease.leaseId!, "Editor process still running");
  expect(() => store.beginRecovery(slot.id, "wrong-token")).toThrow("changed");
  const recovery = store.beginRecovery(slot.id, lease.leaseId);
  expect(recovery.state).toBe("releasing");
  expect(recovery.ownerThreadId).toBe("alice");
  expect(recovery.leaseId).not.toBe(lease.leaseId);
  expect(() => store.completeRelease(slot.id, lease.leaseId!)).toThrow("changed");
  expect(store.completeRelease(slot.id, recovery.leaseId!).state).toBe("available");
});

test("confirmed abandoned leases can enter recovery without any automatic expiration", () => {
  const { store, slot } = setup();
  const lease = acquire(store, slot.id);
  const recovery = store.beginRecovery(slot.id, lease.leaseId);
  expect(recovery.state).toBe("releasing");
  expect(recovery.leaseId).not.toBe(lease.leaseId);
  expect(store.quarantine(slot.id, recovery.leaseId!, "Host unavailable").state).toBe(
    "quarantined",
  );
});

test("Editor claim rows block adoption, acquisition, release, and retirement without parsing claim payloads", () => {
  const { db, store, slot } = setup();
  const claim = () =>
    db
      .prepare("INSERT INTO unity_editor_claims (key, host, workspace, record) VALUES (?, ?, ?, ?)")
      .run("claim", "host", "/rampage", "unparseable-json");
  const clear = () => db.prepare("DELETE FROM unity_editor_claims WHERE key = ?").run("claim");
  claim();
  expect(() => store.acquire(slot.id, "host", "project", "alice")).toThrow("all Editor claims");
  expect(() => store.beginRetire(slot.id, "host", "/rampage")).toThrow("all Editor claims");
  clear();
  const reservation = store.acquire(slot.id, "host", "project", "alice");
  claim();
  expect(() => store.completeAcquire(slot.id, reservation.leaseId!)).toThrow("all Editor claims");
  clear();
  const lease = store.completeAcquire(slot.id, reservation.leaseId!);
  claim();
  expect(() => store.beginRelease(slot.id, "alice", lease.leaseId!)).toThrow("all Editor claims");
  expect(() => store.beginRecovery(slot.id, lease.leaseId)).toThrow("all Editor claims");
  clear();
  store.beginRelease(slot.id, "alice", lease.leaseId!);
  claim();
  expect(() => store.completeRelease(slot.id, lease.leaseId!)).toThrow("all Editor claims");
  clear();
  store.completeRelease(slot.id, lease.leaseId!);
  const retiring = store.beginRetire(slot.id, "host", "/rampage");
  claim();
  expect(() => store.completeRetire(slot.id, retiring.leaseId!)).toThrow("all Editor claims");
  clear();
  store.completeRetire(slot.id, retiring.leaseId!);
  claim();
  expect(() => store.register("host", "/rampage", "project")).toThrow("all Editor claims");
  expect(() => store.register("host", "/rampage", "new-project")).toThrow("BB project");
  expect(() => store.register("host", "/new", "project")).not.toThrow();
  expect(() => store.register("new-host", "/rampage", "project")).not.toThrow();
  clear();
  db.prepare(
    "INSERT INTO unity_editor_claims (key, host, workspace, record) VALUES (?, ?, ?, ?)",
  ).run("unregistered", "host", "/unregistered", "{}");
  expect(() => store.register("host", "/unregistered", "project")).toThrow("all Editor claims");
});

test("Editor access requires the checkout lease only for explicitly registered paths", () => {
  const { store, slot } = setup();
  expect(() => store.editorAccess("host", "/existing-unregistered", "bob")).not.toThrow();
  expect(() => store.editorAccess("other-host", "/rampage", "bob")).not.toThrow();
  expect(() => store.editorAccess("host", "/rampage", "alice")).toThrow("available");
  const lease = acquire(store, slot.id);
  expect(() => store.editorAccess("host", "/rampage", "alice")).not.toThrow();
  expect(() => store.editorAccess("host", "/rampage", "bob")).toThrow("@thread:alice");
  store.quarantine(slot.id, lease.leaseId!, "Host disappeared");
  expect(() => store.editorAccess("host", "/rampage", "alice")).toThrow("quarantined");
});

test("retirement reserves an unowned checkout and cannot retire an owner's release", () => {
  const { store, slot } = setup();
  const lease = acquire(store, slot.id);
  expect(() => store.beginRetire(slot.id, "host", "/rampage")).toThrow("leased");
  store.beginRelease(slot.id, "alice", lease.leaseId!);
  expect(() => store.completeRetire(slot.id, lease.leaseId!)).toThrow("its owner");
  store.completeRelease(slot.id, lease.leaseId!);
  expect(() => store.beginRetire(slot.id, "other-host", "/rampage")).toThrow("host or path");
  const retiring = store.beginRetire(slot.id, "host", "/rampage");
  expect(retiring.ownerThreadId).toBeNull();
  expect(store.beginRetire(slot.id, "host", "/rampage")).toEqual(retiring);
  expect(() => store.acquire(slot.id, "host", "project", "bob")).toThrow("releasing");
  expect(store.completeRetire(slot.id, retiring.leaseId!).state).toBe("retired");
  expect(store.completeRetire(slot.id, retiring.leaseId!).state).toBe("retired");
  expect(store.beginRetire(slot.id, "host", "/rampage").state).toBe("retired");
});

test("cache seeding excludes the owner and a reload quarantines the unfinished snapshot", () => {
  const { db, store, slot } = setup();
  const reserved = store.acquire(slot.id, "host", "project", "alice");
  const lease = store.completeAcquire(slot.id, reserved.leaseId!);
  expect(store.beginSeed(slot.id, "alice", lease.leaseId!).state).toBe("seeding");
  expect(() => store.editorAccess("host", "/rampage", "alice")).toThrow("seeding");
  expect(() => store.beginRelease(slot.id, "alice", lease.leaseId!)).toThrow("seeding");
  expect(() => store.acquire(slot.id, "host", "project", "alice")).toThrow("seeding");
  expect(store.completeSeed(slot.id, lease.leaseId!, true)).toMatchObject({
    state: "leased",
    ownerThreadId: "alice",
    leaseId: lease.leaseId,
  });
  store.beginSeed(slot.id, "alice", lease.leaseId!);
  expect(new SlotStore(db).get(slot.id)).toMatchObject({
    state: "quarantined",
    ownerThreadId: "alice",
    leaseId: lease.leaseId,
  });
  expect(() => store.completeSeed(slot.id, lease.leaseId!, false)).toThrow("changed");
});

test("upgrading existing checkout records preserves owner capabilities while enabling seeding", () => {
  const db = database();
  db.exec(`CREATE TABLE unity_checkout_slots (
    id TEXT PRIMARY KEY, host TEXT NOT NULL, workspace TEXT NOT NULL, project TEXT NOT NULL,
    state TEXT CHECK(state IN ('available','preparing','leased','releasing','quarantined','retired')),
    owner TEXT, lease TEXT, reason TEXT, updated TEXT NOT NULL, UNIQUE(host, workspace)
  )`);
  db.prepare("INSERT INTO unity_checkout_slots VALUES (?,?,?,?,?,?,?,?,?)").run(
    "existing",
    "host",
    "/rampage",
    "project",
    "leased",
    "alice",
    "existing-token",
    null,
    "before",
  );
  const store = new SlotStore(db);
  expect(store.get("existing")).toMatchObject({
    state: "leased",
    ownerThreadId: "alice",
    leaseId: "existing-token",
    updatedAt: "before",
  });
  store.beginSeed("existing", "alice", "existing-token");
  expect(store.completeSeed("existing", "existing-token", true)).toMatchObject({
    state: "leased",
    ownerThreadId: "alice",
    leaseId: "existing-token",
  });
});
