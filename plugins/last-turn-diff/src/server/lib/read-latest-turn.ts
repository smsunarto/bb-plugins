import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildLatestTurn, findTurnAnchor, type TurnRow } from "./build-latest-turn.ts";
import type { LatestTurn } from "../../shared/contract.ts";
import type { SnapshotPatch } from "../../shared/host-contract.ts";
import type { TurnWindow } from "./snapshots.ts";

type Threads = BbPluginApi["sdk"]["threads"];
/** Reads the workspace snapshot diff for a turn; null when it has none. */
export type ReadSnapshot = (window: TurnWindow, rows: TurnRow[]) => Promise<SnapshotPatch | null>;
const PAGE_SIZE = 20;
/** Work that can write files without the provider recording a file change. */
const UNRECORDED_WRITERS = new Set(["command", "tool", "extension", "delegation", "workflow"]);

export interface LatestTurnRead {
  turn: LatestTurn;
  /** The completed turn's summary rows, kept for foreign-workspace attribution. */
  rows: TurnRow[];
  /** The environment path with symlinks resolved, when a snapshot supplied it. */
  resolvedRoot?: string;
}

/** Select the newest completed turn with recorded changes, including after no-edit replies. */
export async function readLatestTurn(
  threads: Threads,
  threadId: string,
  readSnapshot?: ReadSnapshot,
): Promise<LatestTurnRead | null> {
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
      const candidate = await readCandidate(
        threads,
        threadId,
        completed,
        boundary,
        timeline,
        readSnapshot,
      );
      if (!candidate) continue;
      const turn = await resolveAnchor(threads, threadId, candidate, timeline);
      return {
        turn,
        rows: candidate.rows,
        ...(candidate.resolvedRoot ? { resolvedRoot: candidate.resolvedRoot } : {}),
      };
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
  readSnapshot: ReadSnapshot | undefined,
): Promise<(LatestTurnRead & { startedSeq: number }) | null> {
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
    // Some historical timelines cannot reconstruct this summary window. The
    // independently recorded aggregate patch is still valid and renderable.
    threads
      .timelineTurnSummaryDetails({
        threadId,
        turnId,
        sourceSeqStart: String(started.seq),
        sourceSeqEnd: String(completed.seq),
      })
      .catch(() => ({ rows: [] })),
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
  const ownRows = details.rows.filter((row) => row.turnId === turnId);
  // The workspace snapshot sees every write, including shell and formatter
  // edits the provider never reports, so it outranks the provider's patch.
  const snapshot = readSnapshot
    ? await readSnapshot(
        { startedAt: started.createdAt, completedAt: completed.createdAt },
        ownRows,
      ).catch(() => null)
    : null;
  const turn = buildLatestTurn(turnId, details.rows, snapshot?.patch ?? patch, timeline.rows);
  if (!addSnapshot(turn, snapshot, ownRows)) return null;

  return {
    turn,
    startedSeq: started.seq,
    rows: details.rows,
    ...(snapshot ? { resolvedRoot: snapshot.root } : {}),
  };
}

/** Fold the snapshot's extras into the turn; false when nothing is worth showing. */
function addSnapshot(turn: LatestTurn, snapshot: SnapshotPatch | null, ownRows: TurnRow[]) {
  if (snapshot?.limited) turn.limited = true;
  const hasOwn = turn.patch !== null || turn.changes.length > 0 || turn.limited;
  // Others' changes alone keep a turn only when it ran something that could
  // have written them. A chat-only reply keeps the previous preview instead.
  if (snapshot?.otherPatch && (hasOwn || ownRows.some(isUnrecordedWriter))) {
    turn.otherPatch = snapshot.otherPatch;
  }
  return hasOwn || turn.otherPatch !== undefined;
}

function isUnrecordedWriter(row: TurnRow): boolean {
  return row.kind === "work" && UNRECORDED_WRITERS.has(row.workKind);
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
