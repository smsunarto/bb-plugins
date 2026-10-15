import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { imageRequest, generationId } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const generateImage = defineTool({
  parameters: imageRequest
    .omit({ kind: true })
    .extend({ gameId: generationId, requestId: generationId }),
  async execute(ctx: ToolContext<GenerationContext>, input) {
    const { gameId, requestId, ...request } = input;
    return JSON.stringify(
      await ctx.generations.start(
        gameId,
        requestId,
        { ...request, kind: "image" },
        ctx.tool.threadId ?? undefined,
      ),
    );
  },
});
