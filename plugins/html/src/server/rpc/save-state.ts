import type { z } from "zod";
import { saveWidgetStateSchema, widgetStateSnapshotSchema } from "../../shared/state-contract.ts";
import type { HtmlContext } from "../lib/context.ts";

export const saveStateContract = {
  experimental_description:
    "Save a visualization's state or Tweak changes, or read its snapshot for sharing",
  input: saveWidgetStateSchema,
  output: widgetStateSnapshotSchema,
};

export async function saveState(
  ctx: HtmlContext,
  input: z.output<typeof saveStateContract.input>,
): Promise<z.input<typeof saveStateContract.output>> {
  await ctx.requireThread(input.threadId);
  return ctx.states.save(input);
}
