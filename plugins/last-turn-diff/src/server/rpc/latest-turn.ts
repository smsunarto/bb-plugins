import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { latestTurnSchema, type LatestTurn } from "../../shared/contract.ts";
import { latestTurnStore } from "../lib/latest-turn-store.ts";

/** Read BB's persisted turn data and the plugin's workspace snapshots. Never writes conversation data. */
export const latestTurn = defineQuery({
  input: z.strictObject({ threadId: z.string().min(1).max(200) }),
  output: z.object({ turn: latestTurnSchema }),
  async execute(ctx, { threadId }): Promise<{ turn: LatestTurn | null }> {
    return { turn: await latestTurnStore(ctx.bb).read(threadId) };
  },
});
