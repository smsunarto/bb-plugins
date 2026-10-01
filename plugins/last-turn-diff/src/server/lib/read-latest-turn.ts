import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildLatestTurn, findTurnAnchor, type TurnRow } from "./build-latest-turn.ts";
import type { LatestTurn } from "../../shared/contract.ts";
import type { SnapshotPatch, TurnWindow } from "../../shared/host-contract.ts";
import type { Attributor } from "./workspace-attribution.ts";

type Threads = BbPluginApi["sdk"]["threads"];
type Event = Awaited<ReturnType<Threads["events"]["list"]>>[number];
/** Reads the workspace snapshot diff for a turn; null when it has none. */
export type ReadSnapshot = (window: TurnWindow, rows: TurnRow[]) => Promise<SnapshotPatch | null>;
const PAGE_SIZE = 20;
/** Work that can write files without the provider recording a file change. */
const UNRECORDED_WRITERS = new Set(["command", "tool", "extension", "delegation", "workflow"]);

export interface Coverage {
  /** The environment path with symlinks resolved, as providers may report it. */
  root: string;
  /** Environment-relative submodule roots the snapshot cannot see into. */
  uncovered: string[];
}

/**
 * Select the newest completed turn with changes to show, including after
 * no-edit replies. Each candidate is attributed before that decision, so a
 * turn whose edits all net out keeps the previous preview.
 */
export async function readLatestTurn(
  threads: Threads,
  threadId: string,
  readSnapshot?: ReadSnapshot,
  attribute: Attributor = (turn) => turn,
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
      const candidate = await readCandidate(
        threads,
        threadId,
        completed,
        boundary,
        timeline,
        readSnapshot,
        attribute,
      );
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
  completed: Event,
  boundary: number | null,
  timeline: Awaited<ReturnType<Threads["timeline"]>>,
  readSnapshot: ReadSnapshot | undefined,
  attribute: Attributor,
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
    ? await turnWindow(threads, threadId, started, completed)
        .then((window) => readSnapshot(window, ownRows))
        .catch(() => null)
    : null;
  const built = buildLatestTurn(turnId, details.rows, snapshot?.patch ?? patch, timeline.rows);
  // An empty snapshot proves the checkout ended where it began: edits the
  // provider recorded there were reverted. Attribution keeps rows only for
  // paths the snapshot cannot see.
  if (snapshot?.patch === "") built.patch = "";
  if (snapshot?.limited) built.limited = true;
  const coverage = snapshot ? { root: snapshot.root, uncovered: snapshot.uncovered } : undefined;
  const turn = attribute(built, details.rows, coverage);
  if (!addOthers(turn, snapshot, ownRows)) return null;
  return { turn, startedSeq: started.seq };
}

/** bb's boundaries around the turn, which a capture pair must fit inside. */
async function turnWindow(
  threads: Threads,
  threadId: string,
  started: Event,
  completed: Event,
): Promise<TurnWindow> {
  const [[previous], [next]] = await Promise.all([
    threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
      beforeSeq: String(started.seq),
    }),
    threads.events.list({
      threadId,
      types: ["turn/started"],
      order: "asc",
      limit: "1",
      afterSeq: String(completed.seq),
    }),
  ]);
  return {
    prevCompletedAt: previous?.createdAt ?? 0,
    startedAt: started.createdAt,
    completedAt: completed.createdAt,
    nextStartedAt: next?.createdAt ?? null,
  };
}

/** Add other agents' changes when relevant; false when nothing is worth showing. */
function addOthers(turn: LatestTurn, snapshot: SnapshotPatch | null, ownRows: TurnRow[]) {
  const hasOwn = Boolean(turn.patch?.trim()) || turn.changes.length > 0 || turn.limited;
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
