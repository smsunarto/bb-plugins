import type { Pins } from "../../../shared/vendor/review/src/review-api/document.ts";

/**
 * Trace storage reading needs the external CLI or hosted store, so it is not
 * configured in bb (design §2.3 C, Q2). WP7 owns the final result text.
 */
type TraceStorageKind = "s3" | "hosted";

// Upstream reports `selection.mode`, which is "none" when nothing is configured.
// The list then loads empty, so the Trace tab shows only for uploaded traces.
export async function listPinnedTraces(_cwd: string, _pins: Pins, override?: TraceStorageKind) {
  return {
    ok: true as const,
    configured: false,
    storage: override ?? ("none" as const),
    sources: [] as TraceStorageKind[],
    sessions: [] as never[],
  };
}

export async function readStoredTrace(
  _cwd: string,
  sessionId: string,
  _trace?: string,
  _override?: TraceStorageKind,
) {
  return {
    ok: false as const,
    status: 404 as const,
    error: `Trace not found for session ${sessionId}.`,
  };
}
