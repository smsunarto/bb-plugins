import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSwrCache } from "./cache";

const scopes: Scope.Closeable[] = [];

/** The cache as its callers drive it, alive until the test ends. */
function makeCache<T>(load: (key: string) => Promise<T>, freshMs: number, staleMs: number) {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  const cache = Effect.runSync(
    Scope.provide(
      makeSwrCache(
        (key) => Effect.tryPromise({ try: () => load(key), catch: (error) => error }),
        freshMs,
        staleMs,
      ),
      scope,
    ),
  );
  return {
    get: (key: string, signal?: AbortSignal) => Effect.runPromise(cache.get(key), { signal }),
    refresh: (key: string) => Effect.runPromise(cache.refresh(key)),
  };
}

/** Advance fake time, then give promises and fibers real turns to run. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SwrCache", () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    }),
  );
  afterEach(async () => {
    vi.useRealTimers();
    for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("reuses a fresh value, serves a stale one while refreshing, and waits only when it has nothing", async () => {
    let loads = 0;
    const cache = makeCache(async (key: string) => `${key}#${++loads}`, 1_000, 10_000);

    expect(await cache.get("a")).toBe("a#1");
    expect(await cache.get("a")).toBe("a#1");
    expect(loads).toBe(1);

    await advance(2_000);
    expect(await cache.get("a")).toBe("a#1"); // stale, served at once
    await advance(100);
    expect(await cache.get("a")).toBe("a#2"); // the refresh landed behind it

    await advance(60_000);
    expect(await cache.get("a")).toBe("a#3"); // too old to serve: waited for a load
  });

  it("shares one load between concurrent callers and keeps a stale value when a refresh fails", async () => {
    let loads = 0;
    let fail = false;
    const cache = makeCache(
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
    await advance(2_000);
    expect(await cache.get("k")).toBe(1);
    await advance(100);
    expect(await cache.get("k")).toBe(1);
  });

  it("serves a stale value at once even while its refresh hangs", async () => {
    let loads = 0;
    const cache = makeCache(
      (key: string) => (++loads === 1 ? Promise.resolve(key) : new Promise<string>(() => {})),
      1_000,
      10_000,
    );
    await cache.get("a");
    await advance(2_000);

    expect(await cache.get("a")).toBe("a");
    await advance(100);
    expect(loads).toBe(2);
    expect(await cache.get("a")).toBe("a");
  });

  it("starts a stale value's refresh 50 ms after the read, not during it", async () => {
    let loads = 0;
    const cache = makeCache(async () => ++loads, 1_000, 10_000);
    await cache.get("a");
    await advance(2_000);

    await cache.get("a");
    await advance(49);
    expect(loads).toBe(1);
    await advance(1);
    expect(loads).toBe(2);
  });

  it("starts one refresh for stale reads that arrive together", async () => {
    let loads = 0;
    const refreshed = deferred<number>();
    const cache = makeCache(
      () => (++loads === 1 ? Promise.resolve(1) : refreshed.promise),
      1_000,
      10_000,
    );
    await cache.get("a");
    await advance(2_000);

    expect(await Promise.all([cache.get("a"), cache.get("a"), cache.get("a")])).toEqual([1, 1, 1]);
    await advance(100);
    refreshed.resolve(2);
    await advance(0);

    expect(loads).toBe(2);
    expect(await cache.get("a")).toBe(2);
  });

  it("keeps the stale value after a failed refresh and tries again on the next stale read", async () => {
    let loads = 0;
    const cache = makeCache(
      async () => {
        if (++loads > 1) throw new Error("offline");
        return "kept";
      },
      1_000,
      10_000,
    );
    await cache.get("a");
    await advance(2_000);

    expect(await cache.get("a")).toBe("kept");
    await advance(100);
    expect(loads).toBe(2);
    expect(await cache.get("a")).toBe("kept");
    await advance(100);
    expect(loads).toBe(3);
  });

  it("refreshes on request even when fresh, sharing a load already running", async () => {
    let loads = 0;
    const pending = deferred<number>();
    const cache = makeCache(
      () => (++loads === 1 ? Promise.resolve(1) : pending.promise),
      1_000,
      10_000,
    );
    await cache.get("a");

    const refreshes = Promise.all([cache.refresh("a"), cache.refresh("a")]);
    pending.resolve(2);

    expect(await refreshes).toEqual([2, 2]);
    expect(loads).toBe(2);
    expect(await cache.get("a")).toBe(2);
  });

  it("hands a failed load to every caller waiting on it and keeps nothing", async () => {
    let loads = 0;
    const cache = makeCache(
      async () => {
        if (++loads === 1) throw new Error("offline");
        return "loaded";
      },
      1_000,
      10_000,
    );

    const results = await Promise.allSettled([cache.get("a"), cache.get("a")]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(
      results.map((result) => result.status === "rejected" && (result.reason as Error).message),
    ).toEqual(["offline", "offline"]);
    expect(loads).toBe(1);

    expect(await cache.get("a")).toBe("loaded");
  });

  it("keeps a load running for the callers still waiting when one stops", async () => {
    let loads = 0;
    const pending = deferred<string>();
    const cache = makeCache(
      () => {
        loads++;
        return pending.promise;
      },
      1_000,
      10_000,
    );
    const leaving = new AbortController();

    const first = cache.get("a", leaving.signal).catch(() => "left");
    const second = cache.get("a");
    await advance(0);
    leaving.abort();
    expect(await first).toBe("left");
    pending.resolve("loaded");

    expect(await second).toBe("loaded");
    expect(loads).toBe(1);
    expect(await cache.get("a")).toBe("loaded");
  });
});
