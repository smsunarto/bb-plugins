import { canvasContextInput } from "@argus-labs/game-studio-api";
import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import type { StudioContext } from "../lib/studio-context.ts";
/** A bounded read of the canvas; reads need no thread, only the studio. */
export const canvasContext = defineTool({
  parameters: canvasContextInput,
  async execute(ctx: ToolContext<StudioContext>, input) {
    const { gameId, ...rest } = input;
    const api = await ctx.studio.client();
    return JSON.stringify(await api.canvas.context(gameId, rest));
  },
});
