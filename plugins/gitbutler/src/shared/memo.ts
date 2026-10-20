/**
 * Answers kept by key for `ttlMs`, with one read shared by every caller that
 * asks while it runs. A caller that gives up stops waiting, and the read
 * itself stops once nobody waits for it. A failure is never kept. `clear`
 * forgets everything, reads still running included: a caller after it starts
 * a new read, so a write can make sure nobody is handed what it changed.
 */
export type Memo = {
  read<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Hands out `value` for `key` as if a read had just answered it. */
  prime(key: string, value: unknown): void;
  clear(): void;
};

type Entry = {
  promise: Promise<unknown>;
  /** When the read answered, or null while it runs. */
  settledAt: number | null;
  controller: AbortController;
  waiting: number;
};

export function createMemo({
  ttlMs,
  maxEntries = 256,
  now = Date.now,
  keep = () => true,
}: {
  /** How long an answer is handed out again. Zero shares reads in flight only. */
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
  /** Whether an answer is kept. One it refuses is shared while it is read, like a failure. */
  keep?: (value: unknown) => boolean;
}): Memo {
  const entries = new Map<string, Entry>();

  const fresh = (entry: Entry) => entry.settledAt === null || now() - entry.settledAt < ttlMs;

  // Oldest answers go first. Reads still running are never dropped.
  function prune() {
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) return;
      if (entry.settledAt !== null) entries.delete(key);
    }
  }

  function start(key: string, load: (signal: AbortSignal) => Promise<unknown>): Entry {
    const controller = new AbortController();
    const entry: Entry = { controller, waiting: 0, settledAt: null, promise: Promise.resolve() };
    entry.promise = load(controller.signal).then(
      (value) => {
        if (entries.get(key) === entry) {
          if (ttlMs > 0 && keep(value)) entry.settledAt = now();
          else entries.delete(key);
        }
        return value;
      },
      (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      },
    );
    // Every caller may have left before it fails.
    entry.promise.catch(() => undefined);
    entries.set(key, entry);
    prune();
    return entry;
  }

  function wait(key: string, entry: Entry, signal: AbortSignal): Promise<unknown> {
    entry.waiting += 1;
    let leave = () => {};
    const left = new Promise<never>((_resolve, reject) => {
      leave = () => {
        entry.waiting -= 1;
        if (entry.waiting === 0 && entry.settledAt === null) {
          if (entries.get(key) === entry) entries.delete(key);
          entry.controller.abort(signal.reason);
        }
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", leave, { once: true });
    });
    return Promise.race([entry.promise, left]).finally(() =>
      signal.removeEventListener("abort", leave),
    );
  }

  return {
    read<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
      let entry = entries.get(key);
      if (!entry || !fresh(entry)) entry = start(key, load);
      if (entry.settledAt !== null) return entry.promise as Promise<T>;
      if (!signal) {
        // A caller that cannot give up keeps the read alive for good.
        entry.waiting += 1;
        return entry.promise as Promise<T>;
      }
      return wait(key, entry, signal) as Promise<T>;
    },
    prime(key, value) {
      const entry: Entry = {
        promise: Promise.resolve(value),
        settledAt: now(),
        controller: new AbortController(),
        waiting: 0,
      };
      entries.set(key, entry);
      prune();
    },
    clear() {
      entries.clear();
    },
  };
}
