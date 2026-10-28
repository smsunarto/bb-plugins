import { z } from "zod";
import { BRANCH_REVIEW_CHANNEL, branchReviewRangeSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

export const setBranchViewedContract = {
  input: branchReviewRangeSchema.extend({ path: z.string().min(1).max(8192), viewed: z.boolean() }),
  output: z.strictObject({ viewed: z.enum(["viewed", "unviewed"]) }),
};

export async function setBranchViewed(
  ctx: CodeReviewContext,
  { path, viewed, ...range }: z.output<typeof setBranchViewedContract.input>,
): Promise<z.input<typeof setBranchViewedContract.output>> {
  await ctx.store.setBranchViewed(range, path, viewed);
  ctx.bb.realtime.publish(BRANCH_REVIEW_CHANNEL, range);
  return { viewed: viewed ? ("viewed" as const) : ("unviewed" as const) };
}
