import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { startSchema } from "../../shared/arena.ts";
import type { ArenaContext } from "../command/start.ts";

export const arenaStart = defineTool({
  parameters: startSchema,
  async execute(ctx: ToolContext<ArenaContext>, input) {
    const run = await ctx.arena.start(ctx.tool.threadId, input);
    return JSON.stringify({ runId: run.id, phase: run.phase, embed: `::arena{run="${run.id}"}` });
  },
});
