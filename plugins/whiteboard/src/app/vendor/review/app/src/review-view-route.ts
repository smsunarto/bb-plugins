// Vendored from dev.fast review/app/src/review-view-route.ts @4ecc570 (MIT).
import type { ReviewView } from "../../../../../shared/vendor/review-protocol/src/index.ts";

export type { ReviewView } from "../../../../../shared/vendor/review-protocol/src/index.ts";

export function normalizeReviewView(
  view: ReviewView,
  softwareMapEnabled: boolean,
  hasChangeRange = true,
  hasTraceSessions = true,
  hasCommitRange = hasChangeRange,
): ReviewView {
  if (view === "map" && !softwareMapEnabled) return "review";

  if (view === "trace" && !hasTraceSessions) return "review";

  if ((view === "commits" && !hasCommitRange) || (view === "diff" && !hasChangeRange)) {
    return "review";
  }

  return view;
}

export function reviewViewLabel(view: ReviewView): string {
  if (view === "map") return "Map";

  if (view === "diff") return "Diff";

  if (view === "commits") return "Commits";

  if (view === "trace") return "Trace";

  return "Whiteboard";
}

export function shouldCloseSidePeekForReviewView(view: ReviewView): boolean {
  return view !== "review";
}
