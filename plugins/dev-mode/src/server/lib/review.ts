import type { Evidence, PinnedTarget, ReviewRequest } from "../../shared/review.ts";

import { instructionFiles } from "@bb-kit/core/instructions";

// What the reviewer and the author are told, editable in the Prompt Editor plugin.
export const files = instructionFiles(import.meta.url);

export type ReviewerModels = { claudeModel: string; codexModel: string };
export function reviewerPrompt(
  request: ReviewRequest,
  target: PinnedTarget | null,
  evidence: Evidence[],
): string {
  const body = files.read("review-reviewer", {
    summary: request.summary,
    target: JSON.stringify(target),
    brief: request.brief ?? "No additional brief.",
    evidence: JSON.stringify(evidence),
  });
  const lenses =
    request.kind === "implementation"
      ? [files.read("review-rubric"), files.read("review-code-quality")]
      : [];
  return [body, ...lenses].join("\n\n");
}
