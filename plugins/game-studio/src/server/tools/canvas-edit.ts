import { canvasEditInput } from "@argus-labs/game-studio-api";
import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { withApproval } from "../lib/approval-relay.ts";
import { type StudioContext, toolSession } from "../lib/studio-context.ts";
/** An agent's board edit, and the run it asks for; the person approves a paid run before anything is saved. */
export const canvasEdit = defineTool({
  parameters: canvasEditInput,
  async execute(ctx: ToolContext<StudioContext>, input) {
    const { gameId, ...rest } = input;
    const { api, threadId } = await toolSession(ctx, gameId, ctx.tool.threadId ?? undefined);
    return JSON.stringify(
      await withApproval({ bb: ctx.bb, api, gameId, threadId }, () =>
        api.canvas.edit(gameId, { ...rest, threadId }),
      ),
    );
  },
});
