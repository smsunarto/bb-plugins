import { isRetryable } from "./errors.ts";
import { sleep } from "./sleep.ts";

export interface RetryOptions {
  /** Total number of tries, including the first one. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export const defaultRetryOptions: RetryOptions = {
  attempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
};

/** Wait before the try that follows `attempt`, doubling each time. */
export function backoffDelay(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, options.maxDelayMs);
}

/**
 * Runs `operation` until it succeeds, a failure is not worth repeating, or the
 * attempt budget runs out. The last failure is rethrown untouched so callers
 * still see the original stack.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  overrides: Partial<RetryOptions> = {},
): Promise<T> {
  const options = { ...defaultRetryOptions, ...overrides };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.attempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelay(attempt, options);
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs, options.signal);
    }
  }
}
