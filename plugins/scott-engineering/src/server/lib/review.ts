import type {
  Evidence,
  PinnedTarget,
  Reviewer,
  ReviewMode,
  ReviewRequest,
} from "../../shared/review.ts";

import { instructionFiles } from "@bb-kit/core/instructions";

// What the reviewer and the author are told, editable in the Prompt Editor plugin.
export const files = instructionFiles(import.meta.url);

export type ReviewerModels = { claudeModel: string; codexModel: string };
// Panel modes add a reviewer from the author's own family beside the opposite one.
export const MODES = {
  quick: { reasoningLevel: "medium", panel: false },
  standard: { reasoningLevel: "high", panel: true },
  deep: { reasoningLevel: "max", panel: true },
} as const;
export const REVIEW_TITLE = "Independent review";
export const MANUAL_SKILLS = ["review-quick", "review-standard", "review-deep"];

/** The opposite model family reviews first; panel modes add the author's family second. */
export function pickReviewers(
  author: { providerId: string; model: string | null },
  models: ReviewerModels,
  mode: ReviewMode = "standard",
): [Reviewer, ...Reviewer[]] {
  const openai =
    author.providerId === "codex" ||
    /(?:^|[/:._-])(?:gpt|chatgpt|o\d|codex)(?![a-z])/i.test(author.model ?? "");
  const seat = (providerId: Reviewer["providerId"]): Reviewer => ({
    providerId,
    model: providerId === "claude-code" ? models.claudeModel : models.codexModel,
    reasoningLevel: MODES[mode].reasoningLevel,
    serviceTier: "fast",
  });
  const opposite = seat(openai ? "claude-code" : "codex");
  return MODES[mode].panel ? [opposite, seat(openai ? "codex" : "claude-code")] : [opposite];
}

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
  return [body, ...lenses, files.read("review-report")].join("\n\n");
}

export function authorInstructions(): string {
  return files.read("review-author");
}
