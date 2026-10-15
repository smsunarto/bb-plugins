import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { gameInput } from "../../shared/schema.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const canvasContext = defineTool({
  parameters: gameInput,
  async execute(ctx: ToolContext<GenerationContext>, input) {
    return JSON.stringify(
      await ctx.generations.context(input.gameId, ctx.tool.threadId ?? undefined),
    );
  },
});
