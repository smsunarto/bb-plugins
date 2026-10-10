import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";

/** What the reader wants every bb review to pay attention to. Empty when unset. */
export const reviewInstructions = defineQuery({
  output: z.strictObject({ instructions: z.string() }),
  async execute(ctx: CodeReviewContext) {
    return { instructions: await ctx.store.instructions() };
  },
});
