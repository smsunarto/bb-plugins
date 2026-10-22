import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { BRANCH_REVIEW_CHANNEL, branchReviewRangeSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

export const setBranchViewed = defineMutation({
  input: branchReviewRangeSchema.extend({ path: z.string().min(1).max(8192), viewed: z.boolean() }),
  output: z.strictObject({ viewed: z.enum(["viewed", "unviewed"]) }),
  async execute(ctx: CodeReviewContext, { path, viewed, ...range }) {
    await ctx.store.setBranchViewed(range, path, viewed);
    ctx.bb.realtime.publish(BRANCH_REVIEW_CHANNEL, range);
    return { viewed: viewed ? ("viewed" as const) : ("unviewed" as const) };
  },
});
