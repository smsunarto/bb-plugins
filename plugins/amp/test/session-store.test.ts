import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../src/session-store.ts";
import type { AmpSessionRecord } from "../src/bridge/session.ts";

function tempDirs(): { dir: string; legacyDir: string } {
  const root = mkdtempSync(join(tmpdir(), "bb-amp-store-"));
  return { dir: join(root, "sessions"), legacyDir: join(root, "legacy") };
}

function recordPath(dir: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(dir, `${digest}.json`);
}

const LOCAL: AmpSessionRecord = {
  ampThreadId: "T-local",
  executionTarget: "local",
  threadId: "thr_local",
};

test("round-trips records and survives a reopen", async () => {
  const { dir } = tempDirs();
  const store = createSessionStore({ dir, legacyDir: null });
  assert.equal(await store.read("amp-a"), null);
  await store.write("amp-a", LOCAL);
  await store.write("amp-b", { ampThreadId: "T-orb", executionTarget: "orb", threadId: "thr_o" });
  assert.deepEqual(await store.read("amp-a"), LOCAL);
  assert.deepEqual(await store.read("amp-b"), {
    ampThreadId: "T-orb",
    executionTarget: "orb",
    threadId: "thr_o",
  });

  const reopened = createSessionStore({ dir, legacyDir: null });
  assert.deepEqual(await reopened.read("amp-a"), LOCAL);

  // Keyed by a hash of the caller-provided id, never by the id as a path.
  const raw = JSON.parse(readFileSync(recordPath(dir, "amp-a"), "utf8")) as Record<string, unknown>;
  assert.equal(raw.providerThreadId, "amp-a");
  assert.equal(raw.threadId, "thr_local");
});

test("a null ampThreadId round-trips (fresh restorable record)", async () => {
  const { dir } = tempDirs();
  const store = createSessionStore({ dir, legacyDir: null });
  await store.write("amp-fresh", { ampThreadId: null, executionTarget: "local", threadId: "t" });
  assert.deepEqual(await store.read("amp-fresh"), {
    ampThreadId: null,
    executionTarget: "local",
    threadId: "t",
  });
});

test("corrupt record: read returns null and write recovers", async () => {
  const { dir } = tempDirs();
  const store = createSessionStore({ dir, legacyDir: null });
  await store.write("amp-a", LOCAL);
  writeFileSync(recordPath(dir, "amp-a"), "{ not json", "utf8");
  assert.equal(await store.read("amp-a"), null);
  await store.write("amp-a", LOCAL);
  assert.deepEqual(await store.read("amp-a"), LOCAL);
});

test("falls back to an ACP-era record and maps its Amp thread id", async () => {
  const { dir, legacyDir } = tempDirs();
  mkdirSync(legacyDir, { recursive: true });
  // StoredSession shape: threadId is AMP's own id; no bb thread id existed.
  writeFileSync(
    recordPath(legacyDir, "S-123"),
    JSON.stringify({ sessionId: "S-123", threadId: "T-legacy", updatedAt: 1 }),
    "utf8",
  );
  writeFileSync(
    recordPath(legacyDir, "S-orb"),
    JSON.stringify({ threadId: "T-orb", executionTarget: "orb", updatedAt: 1 }),
    "utf8",
  );
  writeFileSync(
    recordPath(legacyDir, "S-bad"),
    JSON.stringify({ threadId: "T-bad", executionTarget: "remote", updatedAt: 1 }),
    "utf8",
  );
  const store = createSessionStore({ dir, legacyDir });
  assert.deepEqual(await store.read("S-123"), {
    ampThreadId: "T-legacy",
    executionTarget: "local",
    threadId: "",
  });
  assert.deepEqual(await store.read("S-orb"), {
    ampThreadId: "T-orb",
    executionTarget: "orb",
    threadId: "",
  });
  // An invalid execution target fails closed, as the ACP store did.
  assert.equal(await store.read("S-bad"), null);
  // A new-store record shadows the legacy one.
  await store.write("S-123", { ampThreadId: "T-new", executionTarget: "local", threadId: "thr" });
  assert.deepEqual(await store.read("S-123"), {
    ampThreadId: "T-new",
    executionTarget: "local",
    threadId: "thr",
  });
});

test("delete removes the record and its legacy shadow", async () => {
  const { dir, legacyDir } = tempDirs();
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    recordPath(legacyDir, "S-1"),
    JSON.stringify({ threadId: "T-1", updatedAt: 1 }),
    "utf8",
  );
  const store = createSessionStore({ dir, legacyDir });
  await store.write("S-1", LOCAL);
  await store.delete("S-1");
  assert.equal(await store.read("S-1"), null);
  assert.equal(existsSync(recordPath(legacyDir, "S-1")), false);
  // Idempotent.
  await store.delete("S-1");
});

test("prunes beyond the entry bound, evicting the oldest updatedAt", async () => {
  const { dir } = tempDirs();
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 200; index += 1) {
    writeFileSync(
      recordPath(dir, `amp-${index}`),
      JSON.stringify({
        providerThreadId: `amp-${index}`,
        ampThreadId: `T-${index}`,
        executionTarget: "local",
        threadId: `thr-${index}`,
        updatedAt: index + 1,
      }),
      "utf8",
    );
  }
  const store = createSessionStore({ dir, legacyDir: null });
  await store.write("amp-new", LOCAL);
  assert.equal(await store.read("amp-0"), null, "oldest entry should be evicted");
  assert.deepEqual(await store.read("amp-new"), LOCAL);
  assert.deepEqual(await store.read("amp-199"), {
    ampThreadId: "T-199",
    executionTarget: "local",
    threadId: "thr-199",
  });
});
