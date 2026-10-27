import { canvasGenerationInput } from "@argus-labs/game-studio-api";
import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { withApproval } from "../lib/approval-relay.ts";
import { type StudioContext, toolSession } from "../lib/studio-context.ts";
/** A node's run as the agent asks for it from the canvas; the person approves paid runs in the thread. */
export const generateCanvasMedia = defineTool({
  parameters: canvasGenerationInput,
  async execute(ctx: ToolContext<StudioContext>, input) {
    const { gameId, ...rest } = input;
    const session = await toolSession(ctx, gameId, ctx.tool.threadId ?? undefined);
    const { api, threadId } = session;
    return JSON.stringify(
      await withApproval({ bb: ctx.bb, gameId, ...session }, () =>
        api.generations.canvas(gameId, { ...rest, threadId }),
      ),
    );
  },
});
