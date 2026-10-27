/**
 * How many reads run at once, per source and in all. A machine that went to
 * sleep, or a slow Git LFS download, holds only its own source's slots, so
 * every other repository's previews keep loading.
 */
export type Limiter = {
  /** A slot for `key`, once one is free. Call the release once the read is done. */
  acquire(key: string, signal: AbortSignal): Promise<() => void>;
};

type Waiting = { key: string; start: () => void };

export function createLimiter({ perKey, total }: { perKey: number; total: number }): Limiter {
  const active = new Map<string, number>();
  let running = 0;
  const queue: Waiting[] = [];

  const free = (key: string) => running < total && (active.get(key) ?? 0) < perKey;
  const take = (key: string) => {
    running++;
    active.set(key, (active.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running--;
      const left = (active.get(key) ?? 1) - 1;
      if (left === 0) active.delete(key);
      else active.set(key, left);
      // First come, first served, skipping a source that is still full.
      const index = queue.findIndex((waiting) => free(waiting.key));
      if (index >= 0) queue.splice(index, 1)[0]!.start();
    };
  };

  return {
    async acquire(key, signal) {
      signal.throwIfAborted();
      if (free(key)) return take(key);
      return new Promise<() => void>((resolve, reject) => {
        const waiting: Waiting = {
          key,
          start: () => {
            signal.removeEventListener("abort", leave);
            resolve(take(key));
          },
        };
        const leave = () => {
          const index = queue.indexOf(waiting);
          if (index >= 0) queue.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", leave, { once: true });
        queue.push(waiting);
      });
    },
  };
}
