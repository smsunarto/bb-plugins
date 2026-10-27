import { generationId, videoRequest } from "@argus-labs/game-studio-api";
import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { type StudioContext, startGeneration } from "../lib/studio-context.ts";
export const generateVideo = defineTool({
  parameters: videoRequest.omit({ kind: true }).extend({ gameId: generationId, requestId: generationId }),
  async execute(ctx: ToolContext<StudioContext>, input) {
    const { gameId, requestId, ...request } = input;
    return JSON.stringify(
      await startGeneration(
        ctx,
        gameId,
        requestId,
        { ...request, kind: "video" },
        ctx.tool.threadId ?? undefined,
      ),
    );
  },
});
