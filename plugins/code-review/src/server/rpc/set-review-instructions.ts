import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";

const MAX_INSTRUCTIONS = 8000;

/** Saves the instructions every later Codex review gets. Blank clears them. */
export const setReviewInstructions = defineMutation({
  input: z.strictObject({
    instructions: z
      .string()
      .max(MAX_INSTRUCTIONS, `Keep review instructions under ${MAX_INSTRUCTIONS} characters.`),
  }),
  output: z.strictObject({ instructions: z.string() }),
  async execute(ctx: CodeReviewContext, { instructions }) {
    return { instructions: await ctx.store.setInstructions(instructions) };
  },
});
