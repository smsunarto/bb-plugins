import type { CodexInferenceOutput, CodexInferenceErrorCode } from "./contract.ts";

export class AiServiceFailure extends Error {
  readonly code: CodexInferenceErrorCode;

  constructor(code: CodexInferenceErrorCode, message: string) {
    super(message);
    this.name = "AiServiceFailure";
    this.code = code;
  }
}

export function toAiServiceFailure(error: unknown): Extract<CodexInferenceOutput, { ok: false }> {
  if (error instanceof AiServiceFailure) {
    console.error(`codex ai service: ${error.code}: ${error.message}`);
    return { ok: false, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { ok: false, code: "timeout", message };
  }
  // A failed connection, not a failed request: the caller may try again.
  return { ok: false, code: "service_unavailable", message };
}
