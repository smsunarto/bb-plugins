import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Reviewer, ReviewMode, ReviewRun } from "../../shared/schema.ts";

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

type Model = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["models"]>>["models"][number];

const modelFamily = /(?:^|-)(astra|sol|opus|sonnet)(?=-|$|\[)/;
const alternateFamilies = new Map([
  ["astra", "sol"],
  ["sol", "astra"],
  ["opus", "sonnet"],
  ["sonnet", "opus"],
]);

/** Quick's single reviewer stays on its provider, using its available catalog and the same effort. */
export function fallbackReviewer(reviewer: Reviewer, models: Model[]): Reviewer | null {
  const family = reviewer.model.match(modelFamily)?.[1];
  const other = alternateFamilies.get(family ?? "");
  if (!family || !other) return null;
  const preferred = reviewer.model.replace(family, other);
  const candidates = models
    .filter(
      (model) =>
        (!model.routeProviderId || model.routeProviderId === reviewer.providerId) &&
        model.model.match(modelFamily)?.[1] === other &&
        model.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === reviewer.reasoningLevel,
        ),
    )
    .sort((a, b) => b.model.localeCompare(a.model, undefined, { numeric: true }));
  const model = candidates.find((model) => model.model === preferred) ?? candidates[0];
  return model ? { ...reviewer, model: model.model } : null;
}

export function reviewerPrompt(run: ReviewRun): string {
  const { request, target } = run;
  const body = files.read("reviewer", {
    runId: run.id,
    kind: request.kind,
    mode: request.mode,
    summary: request.summary,
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
