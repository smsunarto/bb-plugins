// Helpers shared by the server tests. Nothing here ships: no server module imports it.
import { Duration, Effect, type Clock } from "effect";

/** How a promise stands after `ms` of real time. */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<"resolved" | "rejected" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real time passing, for tests that act while the code under test is waiting. */
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A Clock for tests. Time moves only when the code under test waits on it: a sleep finishes once
 * nothing else is left to run, earliest deadline first, and moves `now` to that deadline. Tests
 * move `now` themselves with `advance`.
 */
export function virtualClock(start: number) {
  let now = start;
  const sleepers: { at: number; wake(): void }[] = [];
  let driving = false;

  // In-memory fakes answer within a few event-loop turns; Effect's scheduler runs on setImmediate.
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async function drive(): Promise<void> {
    driving = true;
    try {
      for (;;) {
        await settle();
        const due = sleepers.filter((sleeper) => Number.isFinite(sleeper.at));
        if (due.length === 0) return;
        const next = due.reduce((earliest, sleeper) =>
          sleeper.at < earliest.at ? sleeper : earliest,
        );
        sleepers.splice(sleepers.indexOf(next), 1);
        now = Math.max(now, next.at);
        next.wake();
      }
    } finally {
      driving = false;
    }
  }

  const nanos = () => BigInt(now) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const sleeper = { at: now + Duration.toMillis(duration), wake: () => resume(Effect.void) };
        sleepers.push(sleeper);
        if (!driving) void drive();
        return Effect.sync(() => {
          const index = sleepers.indexOf(sleeper);
          if (index >= 0) sleepers.splice(index, 1);
        });
      }),
  };
  return {
    clock,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
