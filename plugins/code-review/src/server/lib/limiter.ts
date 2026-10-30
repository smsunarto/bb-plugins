import { Effect, Semaphore } from "effect";

/**
 * How many reads run at once, per source and in all. A machine that went to
 * sleep, or a slow Git LFS download, holds only its own source's slots, so
 * every other repository's previews keep loading.
 */
export type Limiter = {
  /**
   * `work` in one of `key`'s slots and one of the shared ones, first come,
   * first served. A read waits for its source's slot before it queues for a
   * shared one, so a full source never holds shared slots it cannot use.
   */
  run<A, E, R>(key: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};

export function createLimiter({ perKey, total }: { perKey: number; total: number }): Limiter {
  const shared = Semaphore.makeUnsafe(total);
  // Each source's slots, kept while a read holds or waits for one.
  const sources = new Map<string, { slots: Semaphore.Semaphore; users: number }>();

  const join = (key: string) =>
    Effect.sync(() => {
      const source = sources.get(key) ?? { slots: Semaphore.makeUnsafe(perKey), users: 0 };
      source.users++;
      sources.set(key, source);
      return source.slots;
    });
  const leave = (key: string) =>
    Effect.sync(() => {
      const source = sources.get(key);
      if (source && --source.users === 0) sources.delete(key);
    });

  return {
    run: (key, work) =>
      Effect.acquireUseRelease(
        join(key),
        (slots) => slots.withPermit(shared.withPermit(work)),
        () => leave(key),
      ),
  };
}
