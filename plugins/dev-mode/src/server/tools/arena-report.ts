import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { submitSchema } from "../../shared/arena.ts";
import type { ArenaContext } from "../command/start.ts";

export const arenaReport = defineTool({
  parameters: submitSchema,
  async execute(ctx: ToolContext<ArenaContext>, input) {
    return JSON.stringify(await ctx.arena.report(input.runId, ctx.tool.threadId, input.report));
  },
});
