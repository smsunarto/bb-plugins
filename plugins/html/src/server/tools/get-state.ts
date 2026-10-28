import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pageIdSchema, widgetIdentitySchema } from "../../shared/state-contract.ts";
import type { HtmlContext } from "../lib/context.ts";
import { files } from "../lib/instructions.ts";
import { recentStateContext } from "../lib/widget-state.ts";

const parameters = z.strictObject({
  pageId: pageIdSchema.optional(),
  messageId: widgetIdentitySchema.shape.messageId.optional(),
});

export function getState(ctx: HtmlContext) {
  return {
    name: "html_get_state",
    ...files.tool("html_get_state"),
    presentation: {
      label: { pending: "Reading visualization state", completed: "Read visualization state" },
    },
    parameters,
    async execute(input: z.output<typeof parameters>, { threadId }: PluginAgentToolContext) {
      await ctx.requireThread(threadId);
      return recentStateContext(ctx.states.recent(threadId, input));
    },
  };
}
