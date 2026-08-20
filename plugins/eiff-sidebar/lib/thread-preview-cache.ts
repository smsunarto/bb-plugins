import { toPreviewText } from "./preview-text.ts";

export interface ThreadPreviewRequest {
  threadId: string;
  updatedAt: number;
}

export interface ThreadPreviewResult {
  threadId: string;
  text: string | null;
}

type FetchThreadOutput = (threadId: string, signal: AbortSignal) => Promise<string | null>;

export interface ThreadPreviewCacheOptions {
  maxConcurrent?: number;
  timeoutMs?: number;
  staleAfterMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CachedPreview {
  updatedAt: number;
  text: string | null;
  lastSeenAt: number;
}

type Release = () => void;

class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<(release: Release) => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  acquire(): Promise<Release> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private releaseOnce(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.waiting.shift();
      if (next !== undefined) {
        next(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Process-local preview cache and global SDK-call limiter for the RPC.
 *
 * Nulls are cached deliberately. An unchanged thread must not turn an empty or
 * failed output read into repeated work on every sidebar list update.
 */
export class ThreadPreviewCache {
  private readonly fetchOutput: FetchThreadOutput;
  private readonly cache = new Map<string, CachedPreview>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly limiter: ConcurrencyLimiter;
  private readonly timeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    fetchOutput: FetchThreadOutput,
    options: ThreadPreviewCacheOptions = {},
  ) {
    this.fetchOutput = fetchOutput;
    this.limiter = new ConcurrencyLimiter(
      Math.max(1, Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)),
    );
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.staleAfterMs = Math.max(1, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? Date.now;
  }

  async getMany(threads: readonly ThreadPreviewRequest[]): Promise<ThreadPreviewResult[]> {
    const seenAt = this.now();
    this.evictStale(seenAt);

    const previews = await Promise.all(
      threads.map(async ({ threadId, updatedAt }) => ({
        threadId,
        text: await this.getOne(threadId, updatedAt, seenAt),
      })),
    );
    this.evictOverflow();
    return previews;
  }

  private async getOne(
    threadId: string,
    updatedAt: number,
    seenAt: number,
  ): Promise<string | null> {
    const cached = this.cache.get(threadId);
    if (cached !== undefined) {
      cached.lastSeenAt = seenAt;
      if (cached.updatedAt >= updatedAt) return cached.text;
    }

    const key = JSON.stringify([threadId, updatedAt]);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;

    const pending = this.load(threadId).then((text) => {
      const current = this.cache.get(threadId);
      if (current === undefined || current.updatedAt <= updatedAt) {
        this.cache.set(threadId, { updatedAt, text, lastSeenAt: this.now() });
        this.evictOverflow();
      }
      return text;
    });
    this.inFlight.set(key, pending);

    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private async load(threadId: string): Promise<string | null> {
    const release = await this.limiter.acquire();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let resolveAbort: (value: null) => void = () => undefined;
    const aborted = new Promise<null>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = () => resolveAbort(null);
    controller.signal.addEventListener("abort", onAbort, { once: true });

    const output = Promise.resolve()
      .then(() => this.fetchOutput(threadId, controller.signal))
      .then(toPreviewText, () => null);

    try {
      return await Promise.race([output, aborted]);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      release();
    }
  }

  private evictStale(now: number): void {
    const cutoff = now - this.staleAfterMs;
    for (const [threadId, entry] of this.cache) {
      if (entry.lastSeenAt < cutoff) this.cache.delete(threadId);
    }
  }

  private evictOverflow(): void {
    const overflow = this.cache.size - this.maxEntries;
    if (overflow <= 0) return;

    const oldest = [...this.cache.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, overflow);
    for (const [threadId] of oldest) this.cache.delete(threadId);
  }
}
