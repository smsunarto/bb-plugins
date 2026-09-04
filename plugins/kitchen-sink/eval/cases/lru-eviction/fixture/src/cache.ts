import { RecencyList, type RecencyNode } from "./lru-list.ts";
import { CacheMetrics, type RemovalReason } from "./metrics.ts";

export interface CacheOptions {
  /** Ceiling on live entries. */
  maxEntries: number;
  /** Ceiling on the summed weight of live entries. */
  maxBytes: number;
  /** How long a written entry stays usable. */
  ttlMs: number;
  clock: () => number;
}

export interface CacheEntry<T> {
  value: T;
  bytes: number;
  expiresAt: number;
  pinned: boolean;
}

const DEFAULTS: CacheOptions = {
  maxEntries: 512,
  maxBytes: 8 * 1024 * 1024,
  ttlMs: 30_000,
  clock: Date.now,
};

type Node<T> = RecencyNode<CacheEntry<T>>;

export class Cache<T> {
  readonly metrics = new CacheMetrics();

  private readonly entries = new Map<string, Node<T>>();
  private readonly order = new RecencyList<CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private bytesUsed = 0;

  constructor(options: Partial<CacheOptions> = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
    this.maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.clock = options.clock ?? DEFAULTS.clock;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.bytesUsed;
  }

  get(key: string): T | undefined {
    const node = this.entries.get(key);
    if (!node) {
      this.metrics.miss();
      return undefined;
    }

    if (node.value.expiresAt <= this.clock()) {
      this.remove(node, "expired");
      this.metrics.miss();
      return undefined;
    }

    this.order.touch(node);
    this.metrics.hit();
    return node.value.value;
  }

  /**
   * Reads without touching recency. Health probes and dashboards use this so
   * looking at the cache does not change what the cache throws away next.
   */
  peek(key: string): T | undefined {
    const node = this.entries.get(key);
    if (!node || node.value.expiresAt <= this.clock()) return undefined;
    return node.value.value;
  }

  set(key: string, value: T, bytes = 1): boolean {
    if (bytes > this.maxBytes) {
      // Taking it would throw out every other entry and still leave the cache
      // over the weight ceiling, so the write is refused instead.
      this.metrics.reject(bytes);
      return false;
    }

    const expiresAt = this.clock() + this.ttlMs;
    const existing = this.entries.get(key);
    if (existing) {
      // A rewrite keeps the pin. Callers pin a key, not a particular value.
      this.bytesUsed += bytes - existing.value.bytes;
      existing.value.value = value;
      existing.value.bytes = bytes;
      existing.value.expiresAt = expiresAt;
      this.order.touch(existing);
    } else {
      const node = this.order.insert(key, { value, bytes, expiresAt, pinned: false });
      this.entries.set(key, node);
      this.bytesUsed += bytes;
    }

    this.evict();
    return true;
  }

  /** Holds an entry against capacity pressure until it is unpinned or goes stale. */
  pin(key: string): boolean {
    const node = this.entries.get(key);
    if (!node || node.value.expiresAt <= this.clock()) return false;
    node.value.pinned = true;
    return true;
  }

  unpin(key: string): boolean {
    const node = this.entries.get(key);
    if (!node) return false;
    node.value.pinned = false;
    return true;
  }

  delete(key: string): boolean {
    const node = this.entries.get(key);
    if (!node) return false;
    this.unlink(node);
    return true;
  }

  /**
   * Brings the cache back under both ceilings.
   *
   * Stale entries go first, whatever their position, because throwing out a
   * fresh entry while a dead one still holds weight helps nobody. Only then
   * does recency decide, from the least recently used end forward.
   */
  evict(): number {
    let removed = this.sweepExpired();

    while (this.overCapacity()) {
      const target = this.oldestUnpinned();
      if (!target) {
        // Everything left is pinned. The pins win and the cache runs over its
        // ceiling until a caller releases one.
        this.metrics.overflow();
        break;
      }

      // Both ceilings can be over at once. Count it against the entry ceiling
      // first, since that is the one an operator can act on.
      const reason: RemovalReason = this.entries.size > this.maxEntries ? "capacity" : "size";
      this.remove(target, reason);
      removed += 1;
    }

    return removed;
  }

  /**
   * Drops every entry whose deadline has passed. Deadlines are not ordered by
   * recency, so this walks the whole list rather than stopping at the first
   * live entry it meets.
   *
   * A pin holds an entry against capacity pressure, not against staleness, so
   * pinned entries are swept here too.
   */
  sweepExpired(): number {
    const now = this.clock();
    let removed = 0;

    for (const node of this.order.fromOldest()) {
      if (node.value.expiresAt <= now) {
        this.remove(node, "expired");
        removed += 1;
      }
    }

    return removed;
  }

  /** Keys from most to least recently used. */
  keys(): string[] {
    return this.order.keys();
  }

  clear(): void {
    this.entries.clear();
    this.order.clear();
    this.bytesUsed = 0;
  }

  private overCapacity(): boolean {
    return this.entries.size > this.maxEntries || this.bytesUsed > this.maxBytes;
  }

  /** The least recently used entry that is not pinned, or null if every one is. */
  private oldestUnpinned(): Node<T> | null {
    for (const node of this.order.fromOldest()) {
      if (!node.value.pinned) return node;
    }
    return null;
  }

  private remove(node: Node<T>, reason: RemovalReason): void {
    const { bytes } = node.value;
    this.unlink(node);
    this.metrics.recordRemoval(node.key, reason, bytes, this.clock());
  }

  private unlink(node: Node<T>): void {
    this.order.detach(node);
    this.entries.delete(node.key);
    this.bytesUsed -= node.value.bytes;
  }
}
