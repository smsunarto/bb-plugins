import type {
  GtdSidebarAiInferenceCompleteOutput,
  GtdSidebarAiServiceErrorCode,
} from "../../lib/host-contract.ts";

export class AiServiceFailure extends Error {
  readonly code: GtdSidebarAiServiceErrorCode;

  constructor(code: GtdSidebarAiServiceErrorCode, message: string) {
    super(message);
    this.name = "AiServiceFailure";
    this.code = code;
  }
}

export function toAiServiceFailure(
  error: unknown,
): Extract<GtdSidebarAiInferenceCompleteOutput, { ok: false }> {
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
