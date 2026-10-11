import type { ReviewMode, ReviewRun } from "../../shared/schema.ts";

import { instructionFiles } from "@bb-kit/core/instructions";

// What the reviewer and the author are told, editable in the Prompt Editor plugin.
export const files = instructionFiles(import.meta.url);

export type ReviewerModels = { claudeModel: string; codexModel: string };
export const MODES = {
  quick: {
    reasoningLevel: "medium",
    scope:
      "Check the changed behavior and immediate contracts. Use supplied evidence and the smallest checks that resolve concrete risks. Do not start a broad audit or exhaustive sweep.",
  },
  standard: {
    reasoningLevel: "high",
    scope:
      "Check the changed behavior, relevant callers and consumers, and material failure paths. Expand only when a concrete failure hypothesis requires it.",
  },
  deep: {
    reasoningLevel: "max",
    scope:
      "Read the complete scoped diff and examine material correctness, compatibility, security, concurrency, persistence, and dependency risks that apply. Verify candidate findings and state meaningful verification limits. Do not stop at the first finding; avoid unrelated audits.",
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
    target: target
      ? `Pinned ${request.scope} scope: ${JSON.stringify(target)}. The base contains dependency context; review only the base-to-head delta.`
      : "Design proposal is the immutable summary and optional brief of this run. No repository target was supplied.",
    modeScope: MODES[request.mode].scope,
    kindScope:
      request.kind === "design"
        ? "Challenge the goal, constraints, alternatives, unsupported assumptions, ownership, dependency ordering, compatibility, reversibility, and validation strategy. Suggest the cheapest useful experiment. Cite a decision or plan section; do not invent changed-code line numbers. Distinguish tradeoffs from demonstrated defects."
        : "Flag regressions introduced by the scoped diff, with a concrete failure scenario and evidence. Identify provably affected consumers rather than speculating. Read relevant unchanged code and tests when needed. Cite pinned file:line ranges. Skip pre-existing defects, style nits, and intentional changes.",
  });
  return [
    `Review run ${run.id}: ${request.kind}, ${request.mode}.`,
    body,
    `Return only JSON: {"runId":"${run.id}","status":"complete"|"incomplete","findings":[{"priority":0|1|2|3,"title":"...","body":"scenario, evidence, suggested fix","location":"pinned file:line or plan section"}],"coverage":"brief checked scope","limitations":["unresolved risk or verification limit"]}. No Markdown fence. A timeout, missing source, or unfinished verification must not become complete clearance.`,
  ].join("\n\n");
}

export function authorInstructions(): string {
  return files.read("author");
}
