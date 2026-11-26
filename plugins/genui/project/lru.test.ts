import { describe, expect, it } from "vitest";
import { LruMap, THREAD_CACHE } from "./lru";

describe("LruMap", () => {
  it("keeps at most `max` entries, forgetting the least recently used first", () => {
    const cache = new LruMap<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Reading `a` keeps it; `b` is now the oldest.
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.has("b")).toBe(false);
    expect([cache.get("a"), cache.get("c"), cache.get("d")]).toEqual([1, 3, 4]);
  });

  it("replaces a key in place without growing, and refreshes it", () => {
    const cache = new LruMap<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe(10);
    expect(cache.has("b")).toBe(false);
  });

  it("answers undefined for a miss without changing anything", () => {
    const cache = new LruMap<string, number>(THREAD_CACHE);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("stays at THREAD_CACHE (64) entries however many threads it sees", () => {
    const cache = new LruMap<string, number>(THREAD_CACHE);
    for (let index = 0; index < 1000; index++) cache.set(`thr_${index}`, index);
    expect(THREAD_CACHE).toBe(64);
    expect(cache.size).toBe(64);
    expect(cache.has("thr_935")).toBe(false);
    expect(cache.has("thr_936")).toBe(true);
  });
});
