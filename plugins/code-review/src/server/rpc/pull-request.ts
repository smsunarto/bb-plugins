import { z } from "zod";
import { accountSchema, prRefSchema, pullRequestSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadPullRequest } from "../lib/pull-request.ts";

/** One pull request: header, reviewers, timeline, review threads with drafts, and stack. */
export const pullRequestContract = {
  input: z.strictObject({ account: accountSchema, ref: prRefSchema }),
  output: pullRequestSchema,
};

export async function pullRequest(
  ctx: CodeReviewContext,
  { account, ref }: z.output<typeof pullRequestContract.input>,
): Promise<z.input<typeof pullRequestContract.output>> {
  return { ...(await loadPullRequest(ctx.github.as(account), ref)), account };
}
