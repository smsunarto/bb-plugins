import { generationControlInput } from "@argus-labs/game-studio-api";
import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { type StudioContext, toolSession } from "../lib/studio-context.ts";
export const generation = defineTool({
  parameters: generationControlInput,
  async execute(ctx: ToolContext<StudioContext>, input) {
    const { api, threadId } = await toolSession(ctx, input.gameId, ctx.tool.threadId ?? undefined);
    const control =
      input.action === "resume"
        ? api.generations.resume
        : input.action === "cancel"
          ? api.generations.cancel
          : api.generations.status;
    return JSON.stringify(await control(input.gameId, input.jobId, threadId));
  },
});
