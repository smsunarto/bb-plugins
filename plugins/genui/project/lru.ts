/** Most threads whose model or project a source keeps between reads. */
export const THREAD_CACHE = 64;

/**
 * A Map kept to at most `max` entries, least recently used forgotten first.
 * A read moves the entry to the newest end, so threads a view polls stay.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly max: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as K);
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }
}
