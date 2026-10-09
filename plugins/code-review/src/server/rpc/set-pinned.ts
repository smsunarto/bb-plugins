import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { prRefSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Pins or unpins a pull request in the inbox. Returns the pins in order. */
export const setPinned = defineMutation({
  input: z.strictObject({ ref: prRefSchema, pinned: z.boolean() }),
  output: z.strictObject({ pinned: z.array(prRefSchema) }),
  async execute(ctx: CodeReviewContext, { ref, pinned }) {
    return { pinned: await ctx.store.setPinned(ref, pinned) };
  },
});
