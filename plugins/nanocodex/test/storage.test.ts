import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { SubscriptionRevision } from "nanocodex/host";
import type { DurabilityFence, DurabilityRevision } from "nanocodex/durability";
import { createNanocodexStorage } from "../src/storage.ts";
import { snapshot } from "./helpers/native.ts";

test("subscription state uses durable compare-and-swap with secret file permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-storage-"));
  try {
    const storage = createNanocodexStorage(root);
    assert.deepEqual(await storage.subscription.load("nanocodex"), { revision: "0" });
    assert.deepEqual(
      await storage.subscription.compareAndSwap("nanocodex", {
        expectedRevision: "0" as SubscriptionRevision,
        payload: "opaque-secret",
      }),
      { status: "committed", revision: "1" },
    );
    assert.deepEqual(
      await storage.subscription.compareAndSwap("nanocodex", {
        expectedRevision: "0" as SubscriptionRevision,
        payload: "lost-update",
      }),
      { status: "conflict", actualRevision: "1" },
    );
    const path = join(root, "native", "subscription.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, "utf8"), /lost-update/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native durability fences stale owners and compacts opaque journal batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-durability-"));
  try {
    const storage = createNanocodexStorage(root);
    const owner = await storage.durability.acquire("thread-1", { ownerId: "owner-a" });
    assert.deepEqual(
      await storage.durability.append("thread-1", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: "0" as DurabilityRevision,
        payload: "batch-a",
      }),
      { status: "appended", revision: "1" },
    );
    const successor = await storage.durability.acquire("thread-1", { ownerId: "owner-b" });
    assert.deepEqual(
      await storage.durability.append("thread-1", {
        ownerId: owner.ownerId,
        fence: owner.fence as DurabilityFence,
        expectedRevision: "1" as DurabilityRevision,
        payload: "stale",
      }),
      { status: "fenced" },
    );
    assert.deepEqual(
      await storage.durability.compact?.("thread-1", {
        ownerId: successor.ownerId,
        fence: successor.fence,
        expectedRevision: "1" as DurabilityRevision,
        payload: "native-compact",
      }),
      { status: "compacted", revision: "1" },
    );
    assert.deepEqual(await storage.durability.load("thread-1"), {
      revision: "1",
      batches: [{ revision: "1", payload: "native-compact" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork keeps its latest recovery snapshot until durability is established", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-fork-store-"));
  try {
    const storage = createNanocodexStorage(root);
    const source = snapshot("source");
    const firstTurn = snapshot("first-fork-turn");
    const fork = await storage.createFork("fork", source);
    assert.equal(fork.durabilityId, source.prompt_cache_key);
    const scoped = storage.durabilityFor("fork");
    const owner = await scoped.acquire(source.prompt_cache_key, { ownerId: "fork-owner" });
    await scoped.append(source.prompt_cache_key, {
      ownerId: owner.ownerId,
      fence: owner.fence,
      expectedRevision: "0" as DurabilityRevision,
      payload: "fork-journal",
    });
    assert.equal((await storage.durability.load("fork")).revision, "1");
    assert.equal((await storage.durability.load(source.prompt_cache_key)).revision, "0");
    assert.equal(
      await storage.commitCheckpoint("fork", firstTurn, { retainAsForkSeed: true }),
      "0",
    );
    assert.deepEqual((await storage.readThread("fork")).forkSeed, firstTurn);
    await storage.establishDurability("fork");
    assert.equal((await storage.readThread("fork")).forkSeed, undefined);
    assert.deepEqual(await storage.readCheckpoint("fork", "0"), firstTurn);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
