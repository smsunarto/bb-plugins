const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"]);

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * A failure is safe to repeat when the server never accepted the request, or
 * said outright that it could not handle it right now.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return RETRYABLE_STATUS.has(error.status);
  if (error instanceof Error && "code" in error) {
    return RETRYABLE_CODES.has(String((error as Error & { code?: unknown }).code));
  }
  return false;
}
