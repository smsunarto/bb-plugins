import { Effect } from "effect";

/**
 * A Boat client or SDK call as an Effect that behaves like `await`: a plain value is accepted, and
 * the rejection or throw stays the typed failure as it was thrown, so retry policy, `instanceof`
 * checks and messages see today's errors. Interruption aborts the signal handed to `evaluate`.
 */
export const call = <T>(evaluate: (signal: AbortSignal) => T): Effect.Effect<Awaited<T>, unknown> =>
  Effect.tryPromise({
    try: async (signal): Promise<Awaited<T>> => await evaluate(signal),
    catch: (error) => error,
  });
