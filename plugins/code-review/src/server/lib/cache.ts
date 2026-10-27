/**
 * Answers kept by key, least recently used out first. Callers asking while a
 * read runs share it, and a failure is never kept, so the next ask retries.
 * Only for answers that never go stale, such as reads pinned to commits.
 */
export type Cache<T> = { read(key: string, load: () => Promise<T>): Promise<T> };

export function createCache<T>(max: number): Cache<T> {
  const entries = new Map<string, Promise<T>>();
  return {
    read(key, load) {
      const found = entries.get(key);
      if (found) {
        entries.delete(key);
        entries.set(key, found);
        return found;
      }
      const read = load();
      entries.set(key, read);
      read.catch(() => {
        if (entries.get(key) === read) entries.delete(key);
      });
      while (entries.size > max) entries.delete(entries.keys().next().value!);
      return read;
    },
  };
}
