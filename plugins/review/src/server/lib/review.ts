/**
 * Review policy: who reviews, how hard, and what the reviewer and the
 * author are told. Every other file asks this one.
 */

import { instructionFiles } from "@bb-kit/core/instructions";

// What the reviewer and the author are told, editable in the Prompt Editor plugin.
const files = instructionFiles(import.meta.url);

export type ReviewerModels = { claudeModel: string; codexModel: string };

export type Reviewer = {
  providerId: "claude-code" | "codex";
  model: string;
  reasoningLevel: "max";
  serviceTier: "fast";
};

export const REVIEW_TITLE = "Adversarial review";

/**
 * The reviewer runs on the other model family so it does not share the
 * author's blind spots. Only the first-party codex and claude-code
 * providers review, even when another provider serves the same model.
 */
export function pickReviewer(
  author: { providerId: string; model: string | null },
  models: ReviewerModels,
): Reviewer {
  const authorIsOpenAi =
    author.providerId === "codex" ||
    /(?:^|[/:._-])(?:gpt|chatgpt|o\d|codex)(?![a-z])/i.test(author.model ?? "");
  return authorIsOpenAi
    ? {
        providerId: "claude-code",
        model: models.claudeModel,
        reasoningLevel: "max",
        serviceTier: "fast",
      }
    : { providerId: "codex", model: models.codexModel, reasoningLevel: "max", serviceTier: "fast" };
}

export function reviewerPrompt(brief: string): string {
  return files.read("reviewer", { brief: brief.trim() });
}

/** The author's thread instructions: when and how to ask for a review. */
export function authorInstructions(): string {
  return files.read("author");
}
