export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `code` a bb SDK call failed with, such as `thread_not_found`. */
export function sdkErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
