import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwrCache } from "./cache";

describe("SwrCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reuses a fresh value, serves a stale one while refreshing, and waits only when it has nothing", async () => {
    let loads = 0;
    const cache = new SwrCache(async (key: string) => `${key}#${++loads}`, 1_000, 10_000);

    expect(await cache.get("a")).toBe("a#1");
    expect(await cache.get("a")).toBe("a#1");
    expect(loads).toBe(1);

    vi.advanceTimersByTime(2_000);
    expect(await cache.get("a")).toBe("a#1"); // stale, served at once
    await vi.runAllTimersAsync();
    expect(await cache.get("a")).toBe("a#2"); // the refresh landed behind it

    vi.advanceTimersByTime(60_000);
    expect(await cache.get("a")).toBe("a#3"); // too old to serve: waited for a load
  });

  it("shares one load between concurrent callers and keeps a stale value when a refresh fails", async () => {
    let loads = 0;
    let fail = false;
    const cache = new SwrCache(
      async () => {
        loads++;
        if (fail) throw new Error("offline");
        return loads;
      },
      1_000,
      10_000,
    );
    expect(await Promise.all([cache.get("k"), cache.get("k")])).toEqual([1, 1]);
    expect(loads).toBe(1);

    fail = true;
    vi.advanceTimersByTime(2_000);
    expect(await cache.get("k")).toBe(1);
    await vi.runAllTimersAsync();
    expect(await cache.get("k")).toBe(1);
  });
});
