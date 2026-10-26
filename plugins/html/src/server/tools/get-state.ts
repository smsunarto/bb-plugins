import { defineTool } from "@bb-kit/core/tools";
import type { ToolContext } from "@bb-kit/core/tools";
import { z } from "zod";
import { stateSourceSchema, widgetIdentitySchema } from "../../shared/state-contract.ts";
import type { HtmlContext } from "../lib/context.ts";
import { recentStateContext } from "../lib/widget-state.ts";

export const getState = defineTool({
  presentation: {
    label: { pending: "Reading visualization state", completed: "Read visualization state" },
  },
  parameters: z.strictObject({
    file: stateSourceSchema.optional(),
    messageId: widgetIdentitySchema.shape.messageId.optional(),
  }),
  async execute(ctx: ToolContext<HtmlContext>, input) {
    const { threadId } = ctx.tool;
    await ctx.requireThread(threadId);
    return recentStateContext(ctx.states.recent(threadId, input));
  },
});
