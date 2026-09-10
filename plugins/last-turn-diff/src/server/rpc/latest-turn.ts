import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { latestTurnSchema, type LatestTurn } from "../../shared/contract.ts";
import { readLatestTurn } from "../lib/read-latest-turn.ts";

/** Read BB's persisted turn data. Never read Git state or write conversation data. */
export const latestTurn = defineQuery({
  input: z.strictObject({ threadId: z.string().min(1).max(200) }),
  output: z.object({ turn: latestTurnSchema }),
  async execute(ctx, { threadId }): Promise<{ turn: LatestTurn | null }> {
    const turn = await readLatestTurn(ctx.bb.sdk.threads, threadId);
    return { turn };
  },
});
