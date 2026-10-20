import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { lookupSchema } from "../../shared/arena.ts";
import type { ArenaContext } from "../command/start.ts";

export const arenaStop = defineTool({
  parameters: lookupSchema,
  async execute(ctx: ToolContext<ArenaContext>, input) {
    return JSON.stringify(await ctx.arena.stop(input.runId, ctx.tool.threadId));
  },
});
