import { branchReviewedSchema, branchReviewRangeSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import type { z } from "zod";

export const branchReviewedContract = {
  input: branchReviewRangeSchema,
  output: branchReviewedSchema,
};

export async function branchReviewed(
  ctx: CodeReviewContext,
  range: z.output<typeof branchReviewedContract.input>,
): Promise<z.input<typeof branchReviewedContract.output>> {
  return { paths: await ctx.store.branchReviewed(range) };
}
