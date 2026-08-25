/** Two events about one thread inside this window collapse into the first. */
export const DEDUPE_WINDOW_MS = 3_000;
/** Bounds the in-memory per-thread maps on a long-lived server. */
export const MAX_TRACKED_THREADS = 500;

export type NotifyOnceResult<T> =
  | { readonly delivered: true; readonly value: T }
  | { readonly delivered: false; readonly reason: "deduped" | "tooFast" };

export type RunTracker = {
  started(threadId: string): void;
  cancel(threadId: string): void;
  dropped(threadId: string): void;
  notifyOnce<T>(
    threadId: string,
    minRunMs: number,
    deliver: () => Promise<T>,
  ): Promise<NotifyOnceResult<T>>;
  clear(): void;
};

const trackers = new WeakMap<object, RunTracker>();

export function runTracker(bb: object, now: () => number = Date.now): RunTracker {
  const existing = trackers.get(bb);
  if (existing) return existing;
  const created = createRunTracker(now);
  trackers.set(bb, created);
  return created;
}

export function bindRunTracker(bb: object, tracker: RunTracker): void {
  trackers.set(bb, tracker);
}

export function createRunTracker(now: () => number = Date.now): RunTracker {
  const startedAt = new Map<string, number>();
  const notifiedAt = new Map<string, number>();

  function remember(map: Map<string, number>, threadId: string): void {
    map.delete(threadId);
    while (map.size >= MAX_TRACKED_THREADS) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
    map.set(threadId, now());
  }

  return {
    started(threadId) {
      remember(startedAt, threadId);
    },
    cancel(threadId) {
      startedAt.delete(threadId);
    },
    dropped(threadId) {
      startedAt.delete(threadId);
      notifiedAt.delete(threadId);
    },
    async notifyOnce(threadId, minRunMs, deliver) {
      const at = now();
      const lastNotified = notifiedAt.get(threadId);
      if (lastNotified !== undefined && at - lastNotified < DEDUPE_WINDOW_MS) {
        return { delivered: false, reason: "deduped" };
      }
      const start = startedAt.get(threadId);
      if (minRunMs > 0 && start !== undefined && at - start < minRunMs) {
        startedAt.delete(threadId);
        return { delivered: false, reason: "tooFast" };
      }
      startedAt.delete(threadId);
      remember(notifiedAt, threadId);
      try {
        const value = await deliver();
        return { delivered: true, value };
      } catch (error) {
        notifiedAt.delete(threadId);
        throw error;
      }
    },
    clear() {
      startedAt.clear();
      notifiedAt.clear();
    },
  };
}
