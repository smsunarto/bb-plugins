import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";

const MAX_INSTRUCTIONS = 8000;

/** Saves the instructions every later bb review gets. Blank clears them. */
export const setReviewInstructionsContract = {
  input: z.strictObject({
    instructions: z
      .string()
      .max(MAX_INSTRUCTIONS, `Keep review instructions under ${MAX_INSTRUCTIONS} characters.`),
  }),
  output: z.strictObject({ instructions: z.string() }),
};

export async function setReviewInstructions(
  ctx: CodeReviewContext,
  { instructions }: z.output<typeof setReviewInstructionsContract.input>,
): Promise<z.input<typeof setReviewInstructionsContract.output>> {
  return { instructions: await ctx.store.setInstructions(instructions) };
}
