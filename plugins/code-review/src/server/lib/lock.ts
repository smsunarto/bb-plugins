/*
 * Keyed locks for check-then-write sequences: two calls that each read,
 * decide, and write would otherwise both decide on the same stale read. bb
 * runs one server process per plugin, so nothing outside this process
 * writes the plugin's KV or starts its threads, and an in-process lock is
 * enough.
 */

export type WithLock = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Runs each task once every earlier task on its key has settled. Tasks on
 * other keys run alongside. A task that throws still releases the key.
 */
export function createLocks(): WithLock {
  const tails = new Map<string, Promise<void>>();
  return async (key, task) => {
    const previous = tails.get(key);
    let release = () => {};
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      // The last task out forgets the key, so the map only holds keys in use.
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
