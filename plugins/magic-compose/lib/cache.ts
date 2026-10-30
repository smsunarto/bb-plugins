// Slow-changing facts a dispatch should not wait for: a fresh answer is
// reused, a stale one is served at once while a refresh runs behind it, and
// only a missing one makes the caller wait.
import { Clock, Effect, Fiber, FiberMap, Option, type Scope } from "effect";

const REFRESH_DELAY_MS = 50;

export interface SwrCache<A, E> {
  get(key: string): Effect.Effect<A, E>;
  /** Load `key` now, sharing the work with anyone already loading it. */
  refresh(key: string): Effect.Effect<A, E>;
}

/**
 * Each key has at most one load at a time, in a fiber the cache owns: a caller
 * that stops waiting leaves it running for everyone else, and closing the
 * cache's scope stops it.
 */
export const makeSwrCache = Effect.fnUntraced(function* <A, E>(
  load: (key: string) => Effect.Effect<A, E>,
  freshMs: number,
  staleMs: number,
): Effect.fn.Return<SwrCache<A, E>, never, Scope.Scope> {
  const entries = new Map<string, { value: A; at: number }>();
  const loads = yield* FiberMap.make<string, A, E>();

  /** The load running for `key`, or a new one that starts after `delayMs`. */
  const loading = (key: string, delayMs = 0) =>
    Effect.suspend(() => {
      const running = FiberMap.getUnsafe(loads, key);
      if (Option.isSome(running)) return Effect.succeed(running.value);
      const loaded = load(key).pipe(
        Effect.tap((value) =>
          Effect.map(Clock.currentTimeMillis, (at) => void entries.set(key, { value, at })),
        ),
      );
      return FiberMap.run(loads, key, delayMs === 0 ? loaded : Effect.delay(loaded, delayMs));
    });

  const refresh = (key: string) => Effect.flatMap(loading(key), Fiber.join);

  const get = Effect.fnUntraced(function* (key: string) {
    const entry = entries.get(key);
    const age = entry === undefined ? Infinity : (yield* Clock.currentTimeMillis) - entry.at;
    if (entry !== undefined && age < freshMs) return entry.value;
    if (entry !== undefined && age < staleMs) {
      // The stale value is good enough, and a failed refresh just leaves it in
      // place. The refresh starts a moment later rather than now: starting one
      // can cost synchronous work, and the caller is about to do something
      // that matters more.
      yield* loading(key, REFRESH_DELAY_MS);
      return entry.value;
    }
    return yield* refresh(key);
  });

  return { get, refresh };
});
