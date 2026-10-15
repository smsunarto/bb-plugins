import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { canvasGenerationInput } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const generateCanvasMedia = defineTool({
  parameters: canvasGenerationInput,
  async execute(ctx: ToolContext<GenerationContext>, input) {
    return JSON.stringify(await ctx.generations.canvas(input, ctx.tool.threadId ?? undefined));
  },
});
