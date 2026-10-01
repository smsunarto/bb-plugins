import type { ReviewSession } from "../vendor/review/app/src/host/review-session.tsx";
import type { ReviewView } from "../vendor/review/app/src/review-view-route.ts";
import type { UiTelemetryEventName } from "../../shared/vendor/review/src/ui-telemetry-events.ts";

/**
 * Replaces upstream `ui-telemetry.ts`, `tab-dwell-telemetry.ts`,
 * `peek-telemetry.ts` and `use-review-tab-telemetry.ts` (design §2.3 D).
 * bb plugins send no telemetry, so the capture calls are no-ops with the
 * upstream signatures. Owned by WP4.
 */
type UiTelemetryProperties = Record<string, string | number | boolean>;

export function captureUiEvent(
  _session: ReviewSession,
  _name: UiTelemetryEventName,
  _properties?: UiTelemetryProperties,
  _error?: unknown,
): void {}

export function captureClientError(
  _session: ReviewSession,
  _errorSource: string,
  _cause: unknown,
  _properties?: UiTelemetryProperties,
): void {}

export function useReviewTabTelemetry(_activeView: ReviewView): void {}

/** Upstream keys the session header with this id; it still tags requests. */
export function createReviewAppSessionId(
  cryptoApi: Pick<Crypto, "randomUUID"> | undefined = globalThis.crypto,
): string {
  return cryptoApi?.randomUUID?.() ?? Math.random().toString(16).slice(2);
}

export type PeekResolutionOutcome = "resolved" | "failed" | "pending";

/** Upstream logic, kept: CodePeekCard's placeholder state reads it. */
export function peekResolutionOutcome(input: {
  resolvedCount: number;
  complete: boolean;
  unavailable: boolean;
  error: boolean;
}): PeekResolutionOutcome {
  if (input.resolvedCount > 0) return "resolved";
  return input.complete || input.unavailable || input.error ? "failed" : "pending";
}
