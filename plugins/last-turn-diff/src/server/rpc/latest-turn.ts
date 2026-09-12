import { addUnityContext } from "../lib/unity-context.ts";
import { attributeWorkspaces } from "../lib/workspace-attribution.ts";
import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { latestTurnSchema, type LatestTurn } from "../../shared/contract.ts";
import { readLatestTurn } from "../lib/read-latest-turn.ts";

/** Read BB's persisted turn data. Never read Git state or write conversation data. */
export const latestTurn = defineQuery({
  input: z.strictObject({ threadId: z.string().min(1).max(200) }),
  output: z.object({ turn: latestTurnSchema }),
  async execute(ctx, { threadId }): Promise<{ turn: LatestTurn | null }> {
    const found = await readLatestTurn(ctx.bb.sdk.threads, threadId);
    if (!found) return { turn: null };
    const attributed = await attributeWorkspaces(ctx.bb, threadId, found.turn, found.rows);
    return { turn: await addUnityContext(ctx.bb, threadId, attributed) };
  },
});
