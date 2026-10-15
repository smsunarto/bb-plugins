import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { videoRequest, generationId } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const generateVideo = defineTool({
  parameters: videoRequest
    .omit({ kind: true })
    .extend({ gameId: generationId, requestId: generationId }),
  async execute(ctx: ToolContext<GenerationContext>, input) {
    const { gameId, requestId, ...request } = input;
    return JSON.stringify(
      await ctx.generations.start(
        gameId,
        requestId,
        { ...request, kind: "video" },
        ctx.tool.threadId ?? undefined,
      ),
    );
  },
});
