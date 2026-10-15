import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { generationControlInput } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const generation = defineTool({
  parameters: generationControlInput,
  async execute(ctx: ToolContext<GenerationContext>, input) {
    return JSON.stringify(await ctx.generations.control(input, ctx.tool.threadId ?? undefined));
  },
});
