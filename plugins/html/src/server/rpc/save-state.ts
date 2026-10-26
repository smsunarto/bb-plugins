import { defineMutation } from "@bb-kit/core/rpc";
import { saveWidgetStateSchema, widgetStateSnapshotSchema } from "../../shared/state-contract.ts";
import type { HtmlContext } from "../lib/context.ts";

export const saveState = defineMutation({
  input: saveWidgetStateSchema,
  output: widgetStateSnapshotSchema,
  description: "Save a visualization's state or Tweak changes, or read its snapshot for sharing",
  async execute(ctx: HtmlContext, input) {
    await ctx.requireThread(input.threadId);
    return ctx.states.save(input);
  },
});
