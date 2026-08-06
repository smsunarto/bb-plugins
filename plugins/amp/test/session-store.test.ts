import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSessionStore, defaultSessionStorePath } from "../src/session-store.ts";

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "bb-amp-store-")), "sessions.json");
}

test("round-trips sessionId -> threadId through the file", () => {
  const path = tempStorePath();
  const store = createFileSessionStore(path);
  assert.equal(store.get("S-1"), null);
  store.set("S-1", "T-1");
  assert.equal(store.get("S-1"), "T-1");

  // A second store instance over the same file sees the mapping.
  const reopened = createFileSessionStore(path);
  assert.equal(reopened.get("S-1"), "T-1");

  // The write is a real file (tmp+rename), parseable JSON.
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { threadId: string }>;
  assert.equal(raw["S-1"].threadId, "T-1");
});

test("corrupt store: get returns null and set recovers", () => {
  const path = tempStorePath();
  const store = createFileSessionStore(path);
  store.set("S-old", "T-old");
  writeFileSync(path, "{ not json", "utf8");

  assert.equal(store.get("S-old"), null);
  store.set("S-new", "T-new");
  assert.equal(store.get("S-new"), "T-new");
});

test("prunes beyond MAX_ENTRIES, evicting the oldest updatedAt", () => {
  const path = tempStorePath();
  const seeded: Record<string, { threadId: string; updatedAt: number }> = {};
  for (let index = 0; index < 200; index += 1) {
    seeded[`S-${index}`] = { threadId: `T-${index}`, updatedAt: index + 1 };
  }
  writeFileSync(path, JSON.stringify(seeded), "utf8");

  const store = createFileSessionStore(path);
  store.set("S-new", "T-new");

  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(Object.keys(raw).length, 200);
  assert.equal(store.get("S-new"), "T-new");
  assert.equal(store.get("S-0"), null, "oldest entry should be evicted");
  assert.equal(store.get("S-199"), "T-199");
});

test("defaultSessionStorePath honors XDG_STATE_HOME", () => {
  const path = defaultSessionStorePath({ XDG_STATE_HOME: "/x/state" } as NodeJS.ProcessEnv);
  assert.equal(path, join("/x/state", "bb-plugin-amp", "sessions.json"));
});
