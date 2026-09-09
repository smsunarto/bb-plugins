import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { latestTurnSchema, type LatestTurn } from "../../shared/contract.ts";
import { buildLatestTurn } from "../lib/build-latest-turn.ts";

/** Read BB's persisted turn data. Never read Git state or write conversation data. */
export const latestTurn = defineQuery({
  input: z.strictObject({ threadId: z.string().min(1).max(200) }),
  output: z.object({ turn: latestTurnSchema }),
  async execute(ctx, { threadId }): Promise<{ turn: LatestTurn | null }> {
    const threads = ctx.bb.sdk.threads;
    const [completed] = await threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    if (!completed || completed.scope.kind !== "turn") return { turn: null };
    const turnId = completed.scope.turnId;
    const [started] = await threads.events.list({
      threadId,
      types: ["turn/started"],
      order: "desc",
      limit: "1",
      beforeSeq: String(completed.seq),
    });
    if (!started || started.scope.kind !== "turn" || started.scope.turnId !== turnId)
      return { turn: null };
    const [details, diffs, timeline] = await Promise.all([
      threads.timelineTurnSummaryDetails({
        threadId,
        turnId,
        sourceSeqStart: String(started.seq),
        sourceSeqEnd: String(completed.seq),
      }),
      threads.events.list({
        threadId,
        types: ["turn/diff/updated"],
        order: "desc",
        limit: "1",
        afterSeq: String(started.seq),
        beforeSeq: String(completed.seq),
      }),
      // Work details exclude the final answer. Two timeline segments cover the
      // completed turn plus a subsequent active turn without loading history.
      threads.timeline({ threadId, segmentLimit: "2" }),
    ]);
    const diff = diffs[0];
    const patch =
      diff?.type === "turn/diff/updated" &&
      diff.scope.kind === "turn" &&
      diff.scope.turnId === turnId
        ? (diff.data.diff ?? null)
        : null;
    return { turn: buildLatestTurn(turnId, details.rows, patch, timeline.rows) };
  },
});
