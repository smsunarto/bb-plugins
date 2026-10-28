import { z } from "zod";
import { widgetIdentitySchema, widgetStateSnapshotSchema } from "../../shared/state-contract.ts";
import type { HtmlContext } from "../lib/context.ts";

export const readStateContract = {
  experimental_description: "Read a visualization's saved state, or null before its first save",
  input: widgetIdentitySchema,
  output: z.object({ snapshot: widgetStateSnapshotSchema.nullable() }),
};

export async function readState(
  ctx: HtmlContext,
  input: z.output<typeof readStateContract.input>,
): Promise<z.input<typeof readStateContract.output>> {
  await ctx.requireThread(input.threadId);
  return { snapshot: ctx.states.read(input) };
}
