import type { RenderEmbedOutput } from "../shared/contract.ts";

/**
 * Memory for rendered embeds, shared by every mounted directive.
 *
 * bb remounts message directives whenever its markdown component map changes,
 * and each remount used to refetch the embed and flash "Loading…". Entries
 * here survive remounts and thread navigation. They are freed when:
 *
 * - the server signals that the thread's workspace may have changed
 *   (`invalidateThread` marks entries stale, mounted embeds refetch in place;
 *   `dropThread` deletes them for archived or deleted threads);
 * - the realtime connection recovers, because signals may have been missed
 *   (`invalidateAll`);
 * - the entry count or patch byte budget is exceeded (least recently used
 *   entries go first, in-flight entries are kept);
 * - bb reloads the plugin or the page, which discards this module.
 */

export type EmbedRequest = {
  readonly kind: "code" | "diff";
  readonly threadId: string;
  readonly path: string;
  readonly start?: number;
  readonly end?: number;
};

export type EmbedEntry = {
  /** The last output, or null while the first load is in flight. */
  readonly value: RenderEmbedOutput | null;
  /** True when a newer load is needed. `value` stays visible meanwhile. */
  readonly stale: boolean;
};

type StoredEntry = {
  value: RenderEmbedOutput | null;
  threadId: string;
  bytes: number;
  generation: number;
  loadedGeneration: number;
  inflight: Promise<void> | null;
  lastUsed: number;
};

export type EmbedCacheLimits = {
  readonly maxEntries: number;
  readonly maxBytes: number;
};

const MISSING: EmbedEntry = { value: null, stale: true };

export function embedCacheKey(request: EmbedRequest): string {
  return [
    request.kind,
    request.threadId,
    request.path,
    request.start ?? "",
    request.end ?? "",
  ].join(" ");
}

function outputBytes(value: RenderEmbedOutput): number {
  return value.status === "ready" ? value.patch.length : value.message.length;
}

export class EmbedCache {
  readonly #entries = new Map<string, StoredEntry>();
  readonly #snapshots = new Map<string, EmbedEntry>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #limits: EmbedCacheLimits;
  #bytes = 0;
  #clock = 0;

  constructor(limits: EmbedCacheLimits) {
    this.#limits = limits;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** Stable snapshot for `useSyncExternalStore`. Does not touch recency. */
  read(key: string): EmbedEntry {
    return this.#snapshots.get(key) ?? MISSING;
  }

  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  /** Mark the entry recently used so eviction prefers others. */
  touch(key: string): void {
    const entry = this.#entries.get(key);
    if (entry !== undefined) entry.lastUsed = ++this.#clock;
  }

  /**
   * Fetch when the entry is missing or stale. Concurrent callers for the same
   * key share one request. A thrown fetch is stored as an error output so the
   * embed reports it instead of retrying forever.
   */
  load(
    key: string,
    threadId: string,
    fetch: () => Promise<RenderEmbedOutput>,
    onThrow: (error: unknown) => RenderEmbedOutput,
  ): Promise<void> {
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = {
        value: null,
        threadId,
        bytes: 0,
        generation: 0,
        loadedGeneration: -1,
        inflight: null,
        lastUsed: 0,
      };
      this.#entries.set(key, entry);
    }
    entry.lastUsed = ++this.#clock;
    if (entry.inflight !== null) return entry.inflight;
    if (entry.loadedGeneration === entry.generation) return Promise.resolve();

    const generation = entry.generation;
    const stored = entry;
    const run = async () => {
      let value: RenderEmbedOutput;
      try {
        value = await fetch();
      } catch (error) {
        value = onThrow(error);
      }
      if (this.#entries.get(key) !== stored) return;
      stored.inflight = null;
      this.#bytes -= stored.bytes;
      stored.bytes = outputBytes(value);
      this.#bytes += stored.bytes;
      stored.value = value;
      stored.loadedGeneration = generation;
      this.#publish(key);
      this.#evict(key);
    };
    stored.inflight = run();
    return stored.inflight;
  }

  /** The thread's workspace may have changed: keep values, request reloads. */
  invalidateThread(threadId: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.threadId === threadId) this.#invalidate(key, entry);
    }
  }

  /** Signals may have been missed: request reloads for everything. */
  invalidateAll(): void {
    for (const [key, entry] of this.#entries) this.#invalidate(key, entry);
  }

  /** The thread is gone: nothing will read these again. */
  dropThread(threadId: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.threadId === threadId) this.#delete(key, entry);
    }
  }

  clear(): void {
    for (const [key, entry] of this.#entries) this.#delete(key, entry);
  }

  #invalidate(key: string, entry: StoredEntry): void {
    entry.generation += 1;
    this.#publish(key);
  }

  #delete(key: string, entry: StoredEntry): void {
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    if (this.#snapshots.delete(key)) this.#notify(key);
  }

  #publish(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    const next: EmbedEntry = {
      value: entry.value,
      stale: entry.loadedGeneration !== entry.generation,
    };
    const previous = this.#snapshots.get(key);
    if (previous?.value === next.value && previous.stale === next.stale) return;
    this.#snapshots.set(key, next);
    this.#notify(key);
  }

  #notify(key: string): void {
    const listeners = this.#listeners.get(key);
    if (listeners === undefined) return;
    for (const listener of listeners) listener();
  }

  #evict(keep: string): void {
    const over = () =>
      this.#entries.size > this.#limits.maxEntries || this.#bytes > this.#limits.maxBytes;
    if (!over()) return;
    const candidates = [...this.#entries]
      .filter(([key, entry]) => key !== keep && entry.inflight === null)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [key, entry] of candidates) {
      if (!over()) return;
      this.#delete(key, entry);
    }
  }
}

export const EMBED_CACHE_LIMITS: EmbedCacheLimits = {
  maxEntries: 128,
  maxBytes: 4_000_000,
};

export const embedCache = new EmbedCache(EMBED_CACHE_LIMITS);
