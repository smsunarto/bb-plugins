import { workerTool } from "../lib/scope.ts";
import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { lookupSchema } from "../../shared/arena.ts";
import type { ArenaContext } from "../command/start.ts";

export const arenaContext = defineTool({
  enabled: workerTool,
  parameters: lookupSchema,
  async execute(ctx: ToolContext<ArenaContext>, input) {
    return JSON.stringify(await ctx.arena.context(input.runId, ctx.tool.threadId));
  },
});
