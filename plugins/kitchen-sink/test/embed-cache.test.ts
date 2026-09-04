import { expect, test } from "bun:test";

import type { RenderEmbedOutput } from "../src/shared/contract.ts";
import { EmbedCache, embedCacheKey } from "../src/app/embed-cache.ts";

function ready(patch: string): RenderEmbedOutput {
  return { status: "ready", kind: "code", path: "a.ts", label: "a.ts", patch, truncated: false };
}

const onThrow = (): RenderEmbedOutput => ({ status: "error", message: "failed" });

test("keys include every request field", () => {
  expect(embedCacheKey({ kind: "code", threadId: "t", path: "a.ts", start: 1, end: 2 })).toBe(
    "code t a.ts 1 2 ",
  );
  expect(embedCacheKey({ kind: "diff", threadId: "t", path: "a.ts" })).toBe("diff t a.ts   ");
  expect(embedCacheKey({ kind: "patch", threadId: "t", file: "p.patch" })).toBe(
    "patch t    p.patch",
  );
});

test("shares one fetch between concurrent loads and serves later reads without fetching", async () => {
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 1_000 });
  let fetches = 0;
  const fetch = async () => {
    fetches += 1;
    return ready("patch");
  };
  const first = cache.load("k", "t", fetch, onThrow);
  const second = cache.load("k", "t", fetch, onThrow);
  await Promise.all([first, second]);
  await cache.load("k", "t", fetch, onThrow);
  expect(fetches).toBe(1);
  expect(cache.read("k")).toEqual({ value: ready("patch"), stale: false });
});

test("invalidating a thread keeps the old value visible until the reload lands", async () => {
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 1_000 });
  const notified: string[] = [];
  cache.subscribe("k", () => notified.push("k"));
  cache.subscribe("other", () => notified.push("other"));
  await cache.load("k", "t", async () => ready("v1"), onThrow);
  await cache.load("other", "t2", async () => ready("o"), onThrow);
  notified.length = 0;

  cache.invalidateThread("t");
  expect(notified).toEqual(["k"]);
  expect(cache.read("k")).toEqual({ value: ready("v1"), stale: true });
  expect(cache.read("other").stale).toBe(false);

  await cache.load("k", "t", async () => ready("v2"), onThrow);
  expect(cache.read("k")).toEqual({ value: ready("v2"), stale: false });
});

test("invalidateAll marks every entry stale", async () => {
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 1_000 });
  await cache.load("a", "t1", async () => ready("a"), onThrow);
  await cache.load("b", "t2", async () => ready("b"), onThrow);
  cache.invalidateAll();
  expect(cache.read("a").stale).toBe(true);
  expect(cache.read("b").stale).toBe(true);
});

test("dropping a thread frees its entries and notifies subscribers", async () => {
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 1_000 });
  let notified = 0;
  cache.subscribe("k", () => (notified += 1));
  await cache.load("k", "t", async () => ready("v1"), onThrow);
  await cache.load("other", "t2", async () => ready("o"), onThrow);
  notified = 0;
  cache.dropThread("t");
  expect(notified).toBe(1);
  expect(cache.size).toBe(1);
  expect(cache.bytes).toBe(1);
  expect(cache.read("k")).toEqual({ value: null, stale: true });
});

test("evicts least recently used entries past the entry limit", async () => {
  const cache = new EmbedCache({ maxEntries: 2, maxBytes: 1_000 });
  await cache.load("a", "t", async () => ready("a"), onThrow);
  await cache.load("b", "t", async () => ready("b"), onThrow);
  cache.touch("a");
  await cache.load("c", "t", async () => ready("c"), onThrow);
  expect(cache.size).toBe(2);
  expect(cache.read("b").value).toBeNull();
  expect(cache.read("a").value).toEqual(ready("a"));
  expect(cache.read("c").value).toEqual(ready("c"));
});

test("evicts by patch bytes but never the entry that just loaded", async () => {
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 10 });
  await cache.load("a", "t", async () => ready("12345"), onThrow);
  await cache.load("b", "t", async () => ready("123456789012"), onThrow);
  expect(cache.read("a").value).toBeNull();
  expect(cache.read("b").value).toEqual(ready("123456789012"));
  expect(cache.bytes).toBe(12);
});

test("a stale load that lands after a drop is discarded", async () => {
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 1_000 });
  let resolve: (value: RenderEmbedOutput) => void = () => {};
  const pending = cache.load(
    "k",
    "t",
    () => new Promise<RenderEmbedOutput>((r) => (resolve = r)),
    onThrow,
  );
  cache.dropThread("t");
  resolve(ready("late"));
  await pending;
  expect(cache.size).toBe(0);
  expect(cache.read("k")).toEqual({ value: null, stale: true });
});

test("stores thrown fetches as error output", async () => {
  const cache = new EmbedCache({ maxEntries: 10, maxBytes: 1_000 });
  await cache.load(
    "k",
    "t",
    async () => {
      throw new Error("boom");
    },
    onThrow,
  );
  expect(cache.read("k")).toEqual({ value: { status: "error", message: "failed" }, stale: false });
});
