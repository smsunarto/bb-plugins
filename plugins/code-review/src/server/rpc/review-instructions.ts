import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";

/** What the reader wants every bb review to pay attention to. Empty when unset. */
export const reviewInstructionsContract = {
  input: z.null(),
  output: z.strictObject({ instructions: z.string() }),
};

export async function reviewInstructions(
  ctx: CodeReviewContext,
): Promise<z.input<typeof reviewInstructionsContract.output>> {
  return { instructions: await ctx.store.instructions() };
}
