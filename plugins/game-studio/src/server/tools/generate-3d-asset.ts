import { generationId, modelRequest } from "@argus-labs/game-studio-api";
import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { type StudioContext, startGeneration } from "../lib/studio-context.ts";
export const generate3dAsset = defineTool({
  parameters: modelRequest.omit({ kind: true }).extend({ gameId: generationId, requestId: generationId }),
  async execute(ctx: ToolContext<StudioContext>, input) {
    const { gameId, requestId, ...request } = input;
    return JSON.stringify(
      await startGeneration(
        ctx,
        gameId,
        requestId,
        { ...request, kind: "model-3d" },
        ctx.tool.threadId ?? undefined,
      ),
    );
  },
});
