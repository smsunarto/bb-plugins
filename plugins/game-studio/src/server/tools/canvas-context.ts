import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { canvasContextInput } from "../../shared/canvas-agent.ts";
import type { GenerationContext } from "../lib/generations.ts";

export const canvasContext = defineTool({
  parameters: canvasContextInput,
  async execute(ctx: ToolContext<GenerationContext>, input) {
    return JSON.stringify(await ctx.generations.context(input, ctx.tool.threadId ?? undefined));
  },
});
