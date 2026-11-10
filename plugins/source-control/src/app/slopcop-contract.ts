/**
 * A local mirror of SlopCop's discoverable contract (plugin id "slopcop"),
 * which the SlopCop group reads for its run state and Run again. The app
 * calls it through the SDK by plugin id; when SlopCop is not installed the
 * calls fail and the group shows its comments with no run controls.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SLOPCOP_PLUGIN_ID = "slopcop";
export const REVIEW_RUNS_TAG = "review-runs";

const pullRequestInput = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
  number: z.number().int().positive(),
});

export const slopCopContract = defineRpcContract({
  pullRequestReview: {
    input: pullRequestInput,
    output: z.object({
      state: z.enum(["none", "running", "done", "failed"]),
      finishedAt: z.string().nullable(),
      findings: z.number().int().nonnegative(),
      canRunAgain: z.boolean(),
      reason: z.string().nullable(),
    }),
    tags: () => [REVIEW_RUNS_TAG],
  },
  runPullRequestAgain: {
    input: pullRequestInput,
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
});

/** A pull request SlopCop can answer for: "owner/name" and its number. */
export function slopCopInput(repo: string, number: number | null) {
  return number !== null && /^[\w.-]+\/[\w.-]+$/.test(repo) ? { repo, number } : null;
}
