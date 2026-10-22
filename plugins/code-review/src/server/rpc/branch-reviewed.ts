import { defineQuery } from "@bb-kit/core/rpc";
import { branchReviewedSchema, branchReviewRangeSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

export const branchReviewed = defineQuery({
  input: branchReviewRangeSchema,
  output: branchReviewedSchema,
  async execute(ctx: CodeReviewContext, range) {
    return { paths: await ctx.store.branchReviewed(range) };
  },
});
