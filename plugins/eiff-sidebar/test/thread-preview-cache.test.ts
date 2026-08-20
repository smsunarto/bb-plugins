import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThreadPreviewCache } from "../lib/thread-preview-cache.ts";

describe("ThreadPreviewCache", () => {
  it("does not fetch the same thread timestamp twice", async () => {
    let calls = 0;
    const cache = new ThreadPreviewCache(async () => {
      calls += 1;
      return "**Latest** output";
    });

    const request = [{ threadId: "thread-1", updatedAt: 10 }];
    assert.deepEqual(await cache.getMany(request), [
      { threadId: "thread-1", text: "Latest output" },
    ]);
    assert.deepEqual(await cache.getMany(request), [
      { threadId: "thread-1", text: "Latest output" },
    ]);
    assert.equal(calls, 1);
  });

  it("caches null output and failures", async () => {
    let emptyCalls = 0;
    const empty = new ThreadPreviewCache(async () => {
      emptyCalls += 1;
      return null;
    });
    const request = [{ threadId: "empty", updatedAt: 10 }];
    await empty.getMany(request);
    await empty.getMany(request);
    assert.equal(emptyCalls, 1);

    let failedCalls = 0;
    const failed = new ThreadPreviewCache(async () => {
      failedCalls += 1;
      throw new Error("offline");
    });
    assert.deepEqual(await failed.getMany(request), [{ threadId: "empty", text: null }]);
    assert.deepEqual(await failed.getMany(request), [{ threadId: "empty", text: null }]);
    assert.equal(failedCalls, 1);
  });

  it("fetches again when updatedAt changes", async () => {
    let calls = 0;
    const cache = new ThreadPreviewCache(async () => `answer ${++calls}`);

    assert.equal((await cache.getMany([{ threadId: "thread-1", updatedAt: 10 }]))[0]?.text, "answer 1");
    assert.equal((await cache.getMany([{ threadId: "thread-1", updatedAt: 11 }]))[0]?.text, "answer 2");
  });

  it("deduplicates concurrent reads for one timestamp", async () => {
    let calls = 0;
    const cache = new ThreadPreviewCache(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "answer";
    });
    const request = [{ threadId: "thread-1", updatedAt: 10 }];

    await Promise.all([cache.getMany(request), cache.getMany(request)]);
    assert.equal(calls, 1);
  });

  it("limits overlapping batches to six output calls", async () => {
    let active = 0;
    let peak = 0;
    const cache = new ThreadPreviewCache(
      async (threadId) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return threadId;
      },
      { maxConcurrent: 6 },
    );
    const requests = (prefix: string) =>
      Array.from({ length: 10 }, (_, index) => ({
        threadId: `${prefix}-${index}`,
        updatedAt: index,
      }));

    await Promise.all([cache.getMany(requests("a")), cache.getMany(requests("b"))]);
    assert.equal(peak, 6);
  });

  it("returns null for one slow call without rejecting its siblings", async () => {
    const cache = new ThreadPreviewCache(
      async (threadId) => {
        if (threadId === "slow") return new Promise(() => undefined);
        return `**${threadId}**`;
      },
      { timeoutMs: 10, maxConcurrent: 2 },
    );

    assert.deepEqual(
      await cache.getMany([
        { threadId: "slow", updatedAt: 1 },
        { threadId: "fast-1", updatedAt: 1 },
        { threadId: "fast-2", updatedAt: 1 },
      ]),
      [
        { threadId: "slow", text: null },
        { threadId: "fast-1", text: "fast-1" },
        { threadId: "fast-2", text: "fast-2" },
      ],
    );
  });

  it("evicts entries that have not been seen recently", async () => {
    let now = 0;
    let calls = 0;
    const cache = new ThreadPreviewCache(
      async (threadId) => {
        calls += 1;
        return threadId;
      },
      { staleAfterMs: 10, now: () => now },
    );

    await cache.getMany([{ threadId: "old", updatedAt: 1 }]);
    now = 11;
    await cache.getMany([{ threadId: "new", updatedAt: 1 }]);
    await cache.getMany([{ threadId: "old", updatedAt: 1 }]);
    assert.equal(calls, 3);
  });

  it("caps the cache even when every entry is recent", async () => {
    let calls = 0;
    const cache = new ThreadPreviewCache(
      async (threadId) => {
        calls += 1;
        return threadId;
      },
      { maxEntries: 2 },
    );

    await cache.getMany([
      { threadId: "a", updatedAt: 1 },
      { threadId: "b", updatedAt: 1 },
      { threadId: "c", updatedAt: 1 },
    ]);
    await cache.getMany([{ threadId: "a", updatedAt: 1 }]);
    assert.equal(calls, 4);
  });
});
