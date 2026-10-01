// Vendored from dev.fast trace-core/src/error-message.ts @4ecc570 (MIT).
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
