// SlopCop's review state for one pull request, published for other plugins.
//
// Source Control's Review rail reads it with `experimental_useRpcQuery` and
// re-runs a review with `useRpcMutation`, both with `pluginId: "slopcop"`.
// This module imports only the SDK and zod so a caller can copy it verbatim;
// change it here first and keep the copies in step.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Every SlopCop run change invalidates reads carrying this tag. */
export const REVIEW_RUNS_TAG = "review-runs";

const pullRequestInput = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
  number: z.number().int().positive(),
});

export const sourceControlRpcContract = defineRpcContract({
  pullRequestReview: {
    experimental_description:
      "Latest SlopCop review run for one GitHub pull request: running, done, or failed, when it finished, how many inline findings it posted, and whether runPullRequestAgain can start another. Reads local state only.",
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
    experimental_description:
      "Re-run SlopCop's review of one pull request at its current head with the rule that last reviewed it, through SlopCop's normal dispatch and rule matching. Returns ok without starting another run while one for that head is running; otherwise ok: false with a message.",
    input: pullRequestInput,
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
});
