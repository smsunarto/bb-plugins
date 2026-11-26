/**
 * Single-flight refresh queue for the RPIV to-do banner.
 *
 * - At most one load runs at a time; requests during a load coalesce into one
 *   follow-up load.
 * - A load decides whether to poll again (`keepPolling`) or, on failure,
 *   whether to retry; retries back off exponentially from `pollMs` to
 *   `maxBackoffMs`.
 * - Passive signals (`request({ throttle: true })`) run at most once per
 *   `throttleMs` after the previous load settled.
 */
export type RefreshResult =
  | { readonly ok: true; readonly keepPolling: boolean }
  | { readonly ok: false; readonly keepRetrying: boolean };

export interface RefreshSchedulerOptions {
  /** `failures` counts consecutive failed loads before this one. */
  readonly load: (state: { readonly failures: number }) => Promise<RefreshResult>;
  readonly pollMs?: number;
  readonly maxBackoffMs?: number;
  readonly throttleMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

export interface RefreshScheduler {
  request(options?: { readonly throttle?: boolean }): void;
  dispose(): void;
}

export const REFRESH_POLL_MS = 1200;
export const REFRESH_MAX_BACKOFF_MS = 30_000;

export function backoffDelay(failures: number, pollMs: number, maxBackoffMs: number): number {
  return Math.min(pollMs * 2 ** Math.max(0, failures - 1), maxBackoffMs);
}

export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
  const pollMs = options.pollMs ?? REFRESH_POLL_MS;
  const maxBackoffMs = options.maxBackoffMs ?? REFRESH_MAX_BACKOFF_MS;
  const throttleMs = options.throttleMs ?? pollMs;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;

  let disposed = false;
  let inFlight = false;
  let queued = false;
  let failures = 0;
  let lastSettledAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let timerAt = Number.POSITIVE_INFINITY;

  const cancelTimer = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
    timerAt = Number.POSITIVE_INFINITY;
  };

  /** Keeps whichever pending timer fires first. */
  const schedule = (delayMs: number) => {
    if (disposed) return;
    const at = now() + delayMs;
    if (timer !== undefined && timerAt <= at) return;
    cancelTimer();
    timerAt = at;
    timer = setTimer(() => {
      timer = undefined;
      timerAt = Number.POSITIVE_INFINITY;
      void run();
    }, delayMs);
  };

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    cancelTimer();
    inFlight = true;
    let next: number | null = null;
    try {
      const result = await options.load({ failures });
      if (result.ok) {
        failures = 0;
        next = result.keepPolling ? pollMs : null;
      } else {
        failures += 1;
        next = result.keepRetrying ? backoffDelay(failures, pollMs, maxBackoffMs) : null;
      }
    } catch {
      failures += 1;
      next = backoffDelay(failures, pollMs, maxBackoffMs);
    } finally {
      inFlight = false;
      lastSettledAt = now();
    }
    if (disposed) return;
    if (queued) {
      queued = false;
      void run();
    } else if (next !== null) {
      schedule(next);
    }
  };

  return {
    request(requestOptions) {
      if (disposed) return;
      if (inFlight) {
        queued = true;
        return;
      }
      if (requestOptions?.throttle) {
        const wait = lastSettledAt + throttleMs - now();
        if (wait > 0) {
          schedule(wait);
          return;
        }
      }
      void run();
    },
    dispose() {
      disposed = true;
      queued = false;
      cancelTimer();
    },
  };
}
