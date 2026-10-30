import type { ReviewAgentTraceResponse } from "../../shared/review-protocol/index.ts";

import { useReviewSession } from "./host/review-session.tsx";

export type LoadedAgentTrace = Extract<ReviewAgentTraceResponse, { ok: true }>;

export type AgentTraceState =
  | { status: "idle"; trace?: undefined; error?: undefined }
  | { status: "error"; error: string; trace?: undefined }
  | { status: "loaded"; trace: LoadedAgentTrace; error?: undefined };

export function makeAgentTraceKey(sessionId: string, trace?: string | null): string {
  return trace ? `${sessionId}:${trace}` : sessionId;
}

/** The selected trace among those uploaded with this document; bb stores no others. */
export function useAgentTrace(sessionId?: string | null, trace?: string | null): AgentTraceState {
  const session = useReviewSession();

  if (!sessionId) return { status: "idle" };

  const retained = session.review?.traces.get(makeAgentTraceKey(sessionId, trace));

  return retained
    ? { status: "loaded", trace: retained }
    : { status: "error", error: `Trace not found for session ${sessionId}.` };
}
