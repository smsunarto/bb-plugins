/**
 * Review policy: who reviews, how hard, and what the reviewer and the
 * author are told. Every other file asks this one.
 */

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
  return [
    "You are an adversarial reviewer. Another agent wrote the work described below and asked you to find what is wrong with it before it reaches the user.",
    "",
    "- Read the code and run read-only checks. Do not edit files, commit, or spawn threads.",
    "- Hunt for correctness bugs, broken edge cases, wrong assumptions, and missed requirements. Skip style nits.",
    "- Verify each finding against the code before you report it.",
    "- End with a numbered list of findings, most severe first. Give each one a file and line, the failure scenario, and a suggested fix. Say so plainly if you found nothing.",
    "",
    "## Brief from the author",
    "",
    brief.trim(),
  ].join("\n");
}

export const AUTHOR_INSTRUCTIONS = `Before you end a turn with substantial work whose correctness is not already obvious, get an adversarial review of it:

1. Write a brief to a file: the goal, the changed files, and what to attack.
2. Run \`bb review start --file <path>\`. It spawns a hidden reviewer subthread on the other model family and prints its thread ID. The user sees a banner while it runs.
3. Wait with \`bb thread wait <id> --timeout 90s\`. If the wait times out, the review is still running. Repeat until it stops, then read the findings with \`bb thread output <id>\`.
4. Fix the valid findings in this thread before you end the turn.`;
