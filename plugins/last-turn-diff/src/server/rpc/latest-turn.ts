import { addUnityContext } from "../lib/unity-context.ts";
import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { latestTurnSchema, type LatestTurn } from "../../shared/contract.ts";
import { loadLatestTurn } from "../lib/read-latest-turn.ts";

/** Read BB's persisted turn data and the plugin's workspace snapshots. Never writes conversation data. */
export const latestTurn = defineQuery({
  input: z.strictObject({ threadId: z.string().min(1).max(200) }),
  output: z.object({ turn: latestTurnSchema }),
  async execute(ctx, { threadId }): Promise<{ turn: LatestTurn | null }> {
    const turn = await loadLatestTurn(ctx.bb, threadId);
    if (!turn) return { turn: null };
    return { turn: await addUnityContext(ctx.bb, threadId, turn) };
  },
});
