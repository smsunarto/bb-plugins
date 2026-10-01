import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { addUnityContext } from "../lib/unity-context.ts";
import { workspaceAttributor } from "../lib/workspace-attribution.ts";
import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { latestTurnSchema, type LatestTurn } from "../../shared/contract.ts";
import { readLatestTurn } from "../lib/read-latest-turn.ts";
import { resolveTarget, snapshotPatch, type Target } from "../lib/snapshots.ts";

async function threadTarget(bb: BbPluginApi, threadId: string): Promise<Target | null> {
  try {
    return await resolveTarget(bb, await bb.sdk.threads.get({ threadId }));
  } catch {
    return null; // No snapshots: fall back to the provider's recorded changes.
  }
}

/** Read BB's persisted turn data and the plugin's workspace snapshots. Never writes conversation data. */
export const latestTurn = defineQuery({
  input: z.strictObject({ threadId: z.string().min(1).max(200) }),
  output: z.object({ turn: latestTurnSchema }),
  async execute(ctx, { threadId }): Promise<{ turn: LatestTurn | null }> {
    const [target, attribute] = await Promise.all([
      threadTarget(ctx.bb, threadId),
      workspaceAttributor(ctx.bb, threadId),
    ]);
    const turn = await readLatestTurn(
      ctx.bb.sdk.threads,
      threadId,
      target ? (window, rows) => snapshotPatch(ctx.bb, target, threadId, window, rows) : undefined,
      attribute,
    );
    if (!turn) return { turn: null };
    return { turn: await addUnityContext(ctx.bb, threadId, turn) };
  },
});
