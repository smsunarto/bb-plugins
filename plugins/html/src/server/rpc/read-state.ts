import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { widgetIdentitySchema, widgetStateSnapshotSchema } from "../../shared/state-contract.ts";
import type { HtmlContext } from "../lib/context.ts";

export const readState = defineQuery({
  input: widgetIdentitySchema,
  output: z.object({ snapshot: widgetStateSnapshotSchema.nullable() }),
  description: "Read a visualization's saved state, or null before its first save",
  async execute(ctx: HtmlContext, input) {
    await ctx.requireThread(input.threadId);
    return { snapshot: ctx.states.read(input) };
  },
});
