/** A read stopped by its deadline rather than by its caller. */
export class DeadlineError extends Error {
  constructor() {
    super("The read took too long.");
    this.name = "DeadlineError";
  }
}

/**
 * A signal that aborts when `signal` does, or `ms` from now. Built by hand
 * rather than with `AbortSignal.any`, which not every runtime the plugin's
 * code and tests run in provides.
 */
export function withDeadline(ms: number, signal?: AbortSignal): AbortSignal {
  return startDeadline(ms, signal).signal;
}

/**
 * `withDeadline`, with a way to lift the deadline once the slow part is over:
 * a download whose headers arrived streams on, bound only by its caller.
 */
export function startDeadline(
  ms: number,
  signal?: AbortSignal,
): { signal: AbortSignal; lift(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError()), ms);
  (timer as { unref?: () => void }).unref?.();
  const stop = () => {
    clearTimeout(timer);
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return { signal: controller.signal, lift: () => clearTimeout(timer) };
}

/**
 * `promise`, or a rejection with `signal`'s reason once it aborts. For work
 * that cannot be cancelled, or that other callers still wait on.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** Whether `signal` stopped at its deadline. */
export function timedOut(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof DeadlineError;
}
