import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildLatestTurn, findTurnAnchor } from "./build-latest-turn.ts";
import type { LatestTurn } from "../../shared/contract.ts";

type Threads = BbPluginApi["sdk"]["threads"];
const PAGE_SIZE = 20;

/** Select the newest completed turn with recorded changes, including after no-edit replies. */
export async function readLatestTurn(
  threads: Threads,
  threadId: string,
): Promise<LatestTurn | null> {
  const timeline = await threads.timeline({ threadId, segmentLimit: "2" });
  const boundary = timeline.contextBoundarySeq;
  let beforeSeq = String(timeline.maxSeq + 1);
  while (true) {
    const completedTurns = await threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: String(PAGE_SIZE),
      beforeSeq,
      ...(boundary !== null ? { afterSeq: String(boundary) } : {}),
    });
    for (const completed of completedTurns) {
      const candidate = await readCandidate(threads, threadId, completed, boundary, timeline);
      if (!candidate) continue;
      return resolveAnchor(threads, threadId, candidate, timeline);
    }
    if (completedTurns.length < PAGE_SIZE) return null;
    const oldest = completedTurns.at(-1)!;
    if (oldest.seq >= Number(beforeSeq)) return null;
    beforeSeq = String(oldest.seq);
  }
}

async function readCandidate(
  threads: Threads,
  threadId: string,
  completed: Awaited<ReturnType<Threads["events"]["list"]>>[number],
  boundary: number | null,
  timeline: Awaited<ReturnType<Threads["timeline"]>>,
): Promise<{ turn: LatestTurn; startedSeq: number } | null> {
  if (completed.scope.kind !== "turn") return null;
  const turnId = completed.scope.turnId;
  const [started] = await threads.events.list({
    threadId,
    types: ["turn/started"],
    order: "desc",
    limit: "1",
    beforeSeq: String(completed.seq),
    ...(boundary !== null ? { afterSeq: String(boundary) } : {}),
  });
  if (!started || started.scope.kind !== "turn" || started.scope.turnId !== turnId) return null;
  const [details, diffs] = await Promise.all([
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
  ]);
  const diff = diffs[0];
  const patch =
    diff?.type === "turn/diff/updated" && diff.scope.kind === "turn" && diff.scope.turnId === turnId
      ? (diff.data.diff ?? null)
      : null;
  const turn = buildLatestTurn(turnId, details.rows, patch, timeline.rows);
  if (turn.patch === null && turn.changes.length === 0 && !turn.limited) return null;

  return { turn, startedSeq: started.seq };
}

async function resolveAnchor(
  threads: Threads,
  threadId: string,
  { turn, startedSeq }: { turn: LatestTurn; startedSeq: number },
  timeline: Awaited<ReturnType<Threads["timeline"]>>,
): Promise<LatestTurn> {
  // The retained answer may be outside the latest timeline page. Resolve its
  // actual row ID so the preview stays attached to the response that made it.
  while (turn.anchorId === null && timeline.timelinePage.hasOlderRows) {
    const cursor = timeline.timelinePage.olderCursor;
    if (!cursor || cursor.anchorSeq <= startedSeq) break;
    timeline = await threads.timeline({
      threadId,
      segmentLimit: String(PAGE_SIZE),
      beforeAnchorId: cursor.anchorId,
      beforeAnchorSeq: String(cursor.anchorSeq),
    });
    turn.anchorId = findTurnAnchor(turn.turnId, timeline.rows);
    if (timeline.timelinePage.olderCursor?.anchorSeq === cursor.anchorSeq) break;
  }
  return turn;
}
