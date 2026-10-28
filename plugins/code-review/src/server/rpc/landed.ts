import type { z } from "zod";
import { landedSchema, landedTargetSchema } from "../../shared/landed.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { readLanded } from "../lib/landed.ts";

/** Whether a landed card's pull requests merged and its commits reached their default branch. */
export const landedContract = {
  input: landedTargetSchema,
  output: landedSchema,
};

export function landed(
  ctx: CodeReviewContext,
  { account, prs, commits }: z.output<typeof landedContract.input>,
): Promise<z.input<typeof landedContract.output>> {
  return readLanded(ctx.github.as(account), { prs, commits });
}
