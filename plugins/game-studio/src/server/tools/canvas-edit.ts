import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { canvasEditInput } from "../../shared/canvas-agent.ts";
import type { GenerationContext } from "../lib/generations.ts";

export const canvasEdit = defineTool({
  parameters: canvasEditInput,
  async execute(ctx: ToolContext<GenerationContext>, input) {
    return JSON.stringify(await ctx.generations.editCanvas(input, ctx.tool.threadId ?? undefined));
  },
});
