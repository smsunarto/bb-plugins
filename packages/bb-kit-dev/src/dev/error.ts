export class DevError extends Error {
  readonly code: string;
  readonly action: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, action: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DevError";
    this.code = code;
    this.action = action;
    this.details = details;
  }
}

export function asDevError(error: unknown): DevError {
  if (error instanceof DevError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DevError("internal_error", message, "Inspect the launcher log and retry.");
}
