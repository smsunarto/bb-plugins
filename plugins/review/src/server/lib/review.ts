import type { ReviewMode, ReviewRun } from "../../shared/schema.ts";

import { instructionFiles } from "@bb-kit/core/instructions";

// What the reviewer and the author are told, editable in the Prompt Editor plugin.
export const files = instructionFiles(import.meta.url);

export type ReviewerModels = { claudeModel: string; codexModel: string };
export const MODES = {
  quick: {
    reasoningLevel: "medium",
  },
  standard: {
    reasoningLevel: "high",
  },
  deep: {
    reasoningLevel: "max",
  },
} as const;
export type Reviewer = {
  providerId: "claude-code" | "codex";
  model: string;
  reasoningLevel: "medium" | "high" | "max";
  serviceTier: "fast";
};
export const REVIEW_TITLE = "Independent review";
export const MANUAL_SKILLS = ["review-quick", "review-standard", "review-deep"];

export function pickReviewer(
  author: { providerId: string; model: string | null },
  models: ReviewerModels,
  mode: ReviewMode = "standard",
): Reviewer {
  const openai =
    author.providerId === "codex" ||
    /(?:^|[/:._-])(?:gpt|chatgpt|o\d|codex)(?![a-z])/i.test(author.model ?? "");
  return {
    providerId: openai ? "claude-code" : "codex",
    model: openai ? models.claudeModel : models.codexModel,
    reasoningLevel: MODES[mode].reasoningLevel,
    serviceTier: "fast",
  };
}

export function reviewerPrompt(run: ReviewRun): string {
  const { request, target } = run;
  const body = files.read("reviewer", {
    runId: run.id,
    kind: request.kind,
    mode: request.mode,
    summary: request.summary,
    scope: request.scope,
    target: JSON.stringify(target ?? null),
  });
  const lenses =
    request.kind === "implementation" ? [files.read("rubric"), files.read("code-quality")] : [];
  return [
    `Review run ${run.id}: ${request.kind}, ${request.mode}.`,
    body,
    ...lenses,
    files.read("report", { runId: run.id }),
  ].join("\n\n");
}

export function authorInstructions(): string {
  return files.read("author");
}
