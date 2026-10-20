import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildLatestTurn, findTurnAnchor, type TurnRow } from "./build-latest-turn.ts";
import type { LatestTurn } from "../../shared/contract.ts";
import {
  MAX_SCAN_CANDIDATES,
  type SnapshotPatch,
  type TurnWindow,
} from "../../shared/host-contract.ts";
import { type Attributor } from "./workspace-attribution.ts";
import { isTemporaryPath, turnChanges } from "../../shared/patches.ts";

type Threads = BbPluginApi["sdk"]["threads"];
type Event = Awaited<ReturnType<Threads["events"]["list"]>>[number];
/** Reads the workspace snapshot diff for a turn; null when it has none. */
export type ReadSnapshots = (
  candidates: { window: TurnWindow; rows: TurnRow[]; canWrite: boolean }[],
) => Promise<(SnapshotPatch | null)[]>;
const PAGE_SIZE = 20;
const RECORDED_ATTRIBUTOR: Attributor = {
  apply: (turn) => turn,
  keepPath: (path) => !isTemporaryPath(path),
};
/** Work that can write files without the provider recording a file change. */
const UNRECORDED_WRITERS = new Set(["command", "tool", "extension", "delegation", "workflow"]);

export interface Coverage {
  /** The environment path as given and with symlinks resolved; providers report either. */
  roots: string[];
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
  readSnapshots?: ReadSnapshots,
  attribute: Attributor = RECORDED_ATTRIBUTOR,
  initialTimeline?: Awaited<ReturnType<Threads["timeline"]>>,
): Promise<{ turn: LatestTurn | null; reliable: boolean }> {
  let reliable = true;
  const timeline = initialTimeline ?? (await threads.timeline({ threadId, segmentLimit: "2" }));
  let beforeSeq = String(timeline.maxSeq + 1);
  while (true) {
    const batch = await readCandidateBatch(
      threads,
      threadId,
      timeline,
      beforeSeq,
      !!readSnapshots,
      attribute,
    );
    const { candidates, done } = batch;
    beforeSeq = batch.beforeSeq;
    const snapshots =
      readSnapshots && candidates.length
        ? await readSnapshots(
            candidates.map((c) => ({
              window: c.window!,
              rows: c.ownRows,
              canWrite: c.ownRows.some(isUnrecordedWriter),
            })),
          ).catch(() => [])
        : [];
    const scanned =
      snapshots.length && snapshots.length < candidates.length
        ? candidates.slice(0, snapshots.length)
        : candidates;
    for (const [i, candidate] of scanned.entries()) {
      const built = buildCandidate(candidate, timeline, snapshots[i] ?? null, attribute);
      reliable &&= candidate.reliable;
      if (built) return { turn: await resolveAnchor(threads, threadId, built, timeline), reliable };
    }
    if (scanned.length < candidates.length) {
      beforeSeq = String(scanned.at(-1)!.completedSeq);
    } else if (done) return { turn: null, reliable };
    // A provider edit that the snapshot proves reverted may require an older page.
  }
}

/**
 * Stop metadata reads at a page with provider evidence; collect empty pages
 * into one host scan of at most MAX_SCAN_CANDIDATES windows. Pages shrink to
 * the room left, so no candidate is prepared beyond the batch.
 */
async function readCandidateBatch(
  threads: Threads,
  threadId: string,
  timeline: Awaited<ReturnType<Threads["timeline"]>>,
  beforeSeq: string,
  needsWindow: boolean,
  attribute: Attributor,
) {
  const candidates: PreparedCandidate[] = [];
  const boundary = timeline.contextBoundarySeq;
  while (true) {
    const limit = Math.min(PAGE_SIZE, MAX_SCAN_CANDIDATES - candidates.length);
    const completed = await threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: String(limit),
      beforeSeq,
      ...(boundary !== null ? { afterSeq: String(boundary) } : {}),
    });
    const page = await Promise.all(
      completed.map((event) => prepareCandidate(threads, threadId, event, boundary, needsWindow)),
    );
    candidates.push(...page.filter((c): c is PreparedCandidate => c !== null));
    const oldest = completed.at(-1);
    const done = completed.length < limit || !oldest || oldest.seq >= Number(beforeSeq);
    if (oldest) beforeSeq = String(oldest.seq);
    if (
      done ||
      candidates.length >= MAX_SCAN_CANDIDATES ||
      page.some((c) => c && buildCandidate(c, timeline, null, attribute))
    ) {
      return { candidates, done, beforeSeq };
    }
  }
}

type PreparedCandidate = {
  turnId: string;
  startedSeq: number;
  completedSeq: number;
  rows: TurnRow[];
  ownRows: TurnRow[];
  patch: string | null;
  window: TurnWindow | null;
  reliable: boolean;
};

async function prepareCandidate(
  threads: Threads,
  threadId: string,
  completed: Event,
  boundary: number | null,
  needsWindow: boolean,
): Promise<PreparedCandidate | null> {
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
  let reliable = true;
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
      .catch(() => {
        reliable = false;
        return { rows: [] };
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
  const ownRows = details.rows.filter((row) => row.turnId === turnId);
  return {
    turnId,
    reliable,
    startedSeq: started.seq,
    completedSeq: completed.seq,
    rows: details.rows,
    ownRows,
    patch,
    window: needsWindow ? await turnWindow(threads, threadId, started, completed) : null,
  };
}

function buildCandidate(
  { turnId, startedSeq, rows, ownRows, patch }: PreparedCandidate,
  timeline: Awaited<ReturnType<Threads["timeline"]>>,
  snapshot: SnapshotPatch | null,
  attribute: Attributor,
): { turn: LatestTurn; startedSeq: number } | null {
  const coverage = snapshot
    ? { roots: [snapshot.path, snapshot.root], uncovered: snapshot.uncovered }
    : undefined;
  const built = buildLatestTurn(turnId, rows, snapshot?.patch ?? patch, timeline.rows, (path) =>
    attribute.keepPath(path, coverage),
  );
  // An empty snapshot proves the checkout ended where it began: edits the
  // provider recorded there were reverted. Attribution keeps rows only for
  // paths the snapshot cannot see.
  if (snapshot?.patch === "") built.patch = "";
  if (snapshot?.limited) built.limited = true;
  const turn = attribute.apply(built, rows, coverage);
  if (!addOthers(turn, snapshot, ownRows)) return null;
  return { turn, startedSeq };
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
  const hasOwn = turnChanges(turn).length > 0 || turn.limited;
  // Others' changes alone keep a turn only when it ran something that could
  // have written them. A chat-only reply keeps the previous preview instead.
  if (snapshot?.otherPatch && (hasOwn || ownRows.some(isUnrecordedWriter))) {
    turn.otherPatch = snapshot.otherPatch;
  }
  return turn.limited || turnChanges(turn).length > 0;
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
