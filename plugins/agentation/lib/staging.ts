// Authoritative routing state for Agentation annotations.
//
// Annotation lifecycle (pending, acknowledged, resolved, dismissed) remains in
// the annotation store. This module owns the independent routing lifecycle:
// staged -> sending -> assigned. Callers never infer a delivery target from the
// page where feedback was captured.

import type DatabaseNamespace from "better-sqlite3";

import type { AnnotationRouting, StoredAnnotation } from "./afs.ts";
import { getAnnotation, setAnnotationStatus } from "./store.ts";

type Database = DatabaseNamespace.Database;

export interface ClaimedDispatch {
  id: string;
  threadId: string;
  annotations: StoredAnnotation[];
}

export type TurnAssignmentPhase = "awaiting-start" | "awaiting-finish";

export type ClaimStagedResult =
  | { outcome: "claimed"; dispatch: ClaimedDispatch }
  | { outcome: "stale" };

export type DiscardStagedResult =
  | { outcome: "discarded"; annotations: StoredAnnotation[] }
  | { outcome: "stale" };

type RoutingRow = {
  annotation_id: string;
  state: AnnotationRouting["state"];
  assigned_thread_id: string | null;
  dispatch_id: string | null;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function readAnnotation(payload: string): StoredAnnotation {
  return JSON.parse(payload) as StoredAnnotation;
}

/**
 * Narrow a row to the state it is in. The SQL writers in this module keep each
 * state's ids present, so a row missing one is corrupt rather than a fourth state.
 */
function toRouting(row: RoutingRow): AnnotationRouting {
  const identity = { annotationId: row.annotation_id, updatedAt: row.updated_at };
  switch (row.state) {
    case "staged":
      return { ...identity, state: "staged" };
    case "sending":
      if (row.dispatch_id === null) throw corruptRoutingRow(row);
      return { ...identity, state: "sending", dispatchId: row.dispatch_id };
    case "assigned":
      if (row.assigned_thread_id === null || row.dispatch_id === null) {
        throw corruptRoutingRow(row);
      }
      return {
        ...identity,
        state: "assigned",
        threadId: row.assigned_thread_id,
        dispatchId: row.dispatch_id,
      };
  }
}

function corruptRoutingRow(row: RoutingRow): Error {
  return new Error(`annotation_routing row ${row.annotation_id} is ${row.state} without its ids`);
}

/**
 * Set acknowledged annotations back to pending. An acknowledgement means the
 * agent of the current assignment picked the annotation up, so it ends when the
 * annotation is staged again or assigned to a thread. Resolved and dismissed
 * annotations keep their status. Returns how many changed.
 */
function reopenAcknowledged(db: Database, annotationIds: readonly string[]): number {
  if (annotationIds.length === 0) return 0;
  const placeholders = annotationIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id FROM annotations
       WHERE id IN (${placeholders}) AND status = 'acknowledged'`,
    )
    .all(...annotationIds) as { id: string }[];
  for (const row of rows) {
    setAnnotationStatus(db, { annotationId: row.id, status: "pending", by: "human" });
  }
  return rows.length;
}

/**
 * Return assigned annotations to staging and forget their turns. With
 * `keepAcknowledged`, only pending annotations move: the agent that
 * acknowledged the rest still owns them. Otherwise acknowledged ones move too
 * and return to pending. Returns how many moved.
 */
function stageAssigned(
  db: Database,
  annotationIds: readonly string[],
  options: { keepAcknowledged: boolean },
): number {
  if (annotationIds.length === 0) return 0;
  const placeholders = annotationIds.map(() => "?").join(", ");
  const statuses = options.keepAcknowledged ? "'pending'" : "'pending', 'acknowledged'";
  const ids = (
    db
      .prepare(
        `SELECT r.annotation_id AS id
         FROM annotation_routing r
         JOIN annotations a ON a.id = r.annotation_id
         WHERE r.annotation_id IN (${placeholders})
           AND r.state = 'assigned'
           AND a.status IN (${statuses})`,
      )
      .all(...annotationIds) as { id: string }[]
  ).map((row) => row.id);
  if (ids.length === 0) return 0;

  const moved = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE annotation_routing
     SET state = 'staged', assigned_thread_id = NULL, dispatch_id = NULL, updated_at = ?
     WHERE annotation_id IN (${moved})`,
  ).run(nowIso(), ...ids);
  db.prepare(`DELETE FROM annotation_turn_assignments WHERE annotation_id IN (${moved})`).run(
    ...ids,
  );
  if (!options.keepAcknowledged) reopenAcknowledged(db, ids);
  return ids.length;
}

export function listStagedAnnotations(db: Database): StoredAnnotation[] {
  const rows = db
    .prepare(
      `SELECT a.payload
       FROM annotation_routing r
       JOIN annotations a ON a.id = r.annotation_id
       WHERE r.state = 'staged'
         AND a.status IN ('pending', 'acknowledged')
       ORDER BY a.created_at ASC, a.seq ASC`,
    )
    .all() as { payload: string }[];
  return rows.map((row) => readAnnotation(row.payload));
}

/**
 * Atomically discard the exact staged snapshot the composer action displayed.
 *
 * A concurrent send or discard makes the request stale and changes nothing.
 * Feedback staged after the composer action rendered is not part of the requested ids,
 * so it remains available for the next action. Discarded feedback becomes a
 * normal human-dismissed annotation and can be reopened from the review panel.
 */
export function discardStagedAnnotations(
  db: Database,
  annotationIds: string[],
): DiscardStagedResult {
  const uniqueIds = [...new Set(annotationIds)];
  if (uniqueIds.length === 0 || uniqueIds.length !== annotationIds.length) {
    return { outcome: "stale" };
  }

  return db.transaction((): DiscardStagedResult => {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT a.id
         FROM annotation_routing r
         JOIN annotations a ON a.id = r.annotation_id
         WHERE r.annotation_id IN (${placeholders})
           AND r.state = 'staged'
           AND a.status IN ('pending', 'acknowledged')`,
      )
      .all(...uniqueIds) as { id: string }[];
    if (rows.length !== uniqueIds.length) return { outcome: "stale" };

    const annotations: StoredAnnotation[] = [];
    for (const annotationId of uniqueIds) {
      const annotation = setAnnotationStatus(db, {
        annotationId,
        status: "dismissed",
        by: "human",
      });
      if (!annotation) {
        throw new Error("staged annotations changed during discard");
      }
      annotations.push(annotation);
    }
    return { outcome: "discarded", annotations };
  })();
}

export function getAnnotationRouting(db: Database, annotationId: string): AnnotationRouting | null {
  const row = db
    .prepare(`SELECT * FROM annotation_routing WHERE annotation_id = ?`)
    .get(annotationId) as RoutingRow | undefined;
  return row ? toRouting(row) : null;
}

export function listAnnotationRoutings(
  db: Database,
  annotationIds: string[],
): Record<string, AnnotationRouting> {
  if (annotationIds.length === 0) return {};
  const uniqueIds = [...new Set(annotationIds)];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM annotation_routing
       WHERE annotation_id IN (${placeholders})`,
    )
    .all(...uniqueIds) as RoutingRow[];
  return Object.fromEntries(rows.map((row) => [row.annotation_id, toRouting(row)]));
}

/**
 * Atomically claim the exact snapshot the composer action displayed.
 *
 * A second pane gets `stale` if any requested item is no longer staged. New
 * annotations that were not in this snapshot remain staged for a later send.
 * Only staged annotations are claimed: one assigned to a thread stays there
 * until it is staged again. A claim starts a new assignment, so acknowledged
 * annotations return to pending.
 */
export function claimStagedAnnotations(
  db: Database,
  input: { annotationIds: string[]; threadId: string },
): ClaimStagedResult {
  const uniqueIds = [...new Set(input.annotationIds)];
  if (uniqueIds.length === 0 || uniqueIds.length !== input.annotationIds.length) {
    return { outcome: "stale" };
  }

  return db.transaction((): ClaimStagedResult => {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT a.id
         FROM annotation_routing r
         JOIN annotations a ON a.id = r.annotation_id
         WHERE r.annotation_id IN (${placeholders})
           AND r.state = 'staged'
           AND a.status IN ('pending', 'acknowledged')`,
      )
      .all(...uniqueIds) as { id: string }[];
    if (rows.length !== uniqueIds.length) return { outcome: "stale" };

    reopenAcknowledged(db, uniqueIds);
    const annotations = uniqueIds.map((annotationId) => getAnnotation(db, annotationId)!);
    const id = `dsp_${crypto.randomUUID()}`;
    const timestamp = nowIso();

    db.prepare(
      `INSERT INTO annotation_dispatches
         (id, thread_id, status, annotation_ids, error, created_at, completed_at)
       VALUES (?, ?, 'sending', ?, NULL, ?, NULL)`,
    ).run(id, input.threadId, JSON.stringify(uniqueIds), timestamp);

    // The target thread lives on the dispatch until delivery is confirmed, so
    // a `sending` row never names a thread it has not reached.
    const update = db.prepare(
      `UPDATE annotation_routing
       SET state = 'sending', dispatch_id = ?, updated_at = ?
       WHERE annotation_id = ? AND state = 'staged'`,
    );
    for (const annotationId of uniqueIds) {
      const result = update.run(id, timestamp, annotationId);
      if (result.changes !== 1) {
        throw new Error("staging claim changed during transaction");
      }
    }

    return {
      outcome: "claimed",
      dispatch: { id, threadId: input.threadId, annotations },
    };
  })();
}

export function completeDispatch(
  db: Database,
  dispatchId: string,
  options: { reappearAfterTurn?: TurnAssignmentPhase } = {},
): number {
  return db.transaction(() => {
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE annotation_routing
         SET state = 'assigned',
             assigned_thread_id = (SELECT thread_id FROM annotation_dispatches WHERE id = ?),
             updated_at = ?
         WHERE dispatch_id = ? AND state = 'sending'`,
      )
      .run(dispatchId, timestamp, dispatchId);
    db.prepare(
      `UPDATE annotation_dispatches
       SET status = 'sent', error = NULL, completed_at = ?
       WHERE id = ? AND status = 'sending'`,
    ).run(timestamp, dispatchId);

    if (options.reappearAfterTurn) {
      db.prepare(
        `INSERT INTO annotation_turn_assignments
           (annotation_id, thread_id, phase, created_at, updated_at)
         SELECT r.annotation_id, r.assigned_thread_id, ?, ?, ?
         FROM annotation_routing r
         JOIN annotations a ON a.id = r.annotation_id
         WHERE r.dispatch_id = ?
           AND r.state = 'assigned'
           AND a.status IN ('pending', 'acknowledged')
         ON CONFLICT(annotation_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           phase = excluded.phase,
           updated_at = excluded.updated_at`,
      ).run(options.reappearAfterTurn, timestamp, timestamp, dispatchId);
    }
    return result.changes;
  })();
}

export function advanceTurnAssignments(db: Database, threadId: string): number {
  return db
    .prepare(
      `UPDATE annotation_turn_assignments
       SET phase = 'awaiting-finish', updated_at = ?
       WHERE thread_id = ? AND phase = 'awaiting-start'`,
    )
    .run(nowIso(), threadId).changes;
}

/**
 * Return a thread's turn assignments to staging once its turn ends. Only
 * annotations the agent never picked up (`pending`) reappear; an acknowledged
 * one belongs to the agent working on it and stays assigned. Use
 * `restageThreadAssignments` when the thread itself is gone.
 */
export function restageTurnAssignments(
  db: Database,
  threadId: string,
  options: { includeAwaitingStart?: boolean } = {},
): number {
  return db.transaction(() => {
    const phaseClause = options.includeAwaitingStart ? "" : "AND phase = 'awaiting-finish'";
    const ids = (
      db
        .prepare(
          `SELECT annotation_id AS id FROM annotation_turn_assignments
           WHERE thread_id = ? ${phaseClause}`,
        )
        .all(threadId) as { id: string }[]
    ).map((row) => row.id);
    const restaged = stageAssigned(db, ids, { keepAcknowledged: true });
    db.prepare(`DELETE FROM annotation_turn_assignments WHERE thread_id = ? ${phaseClause}`).run(
      threadId,
    );
    return restaged;
  })();
}

/**
 * Return everything assigned to a thread that no longer exists to staging,
 * acknowledged annotations included: no agent is left to finish them. Returns
 * how many annotations were re-staged.
 */
export function restageThreadAssignments(db: Database, threadId: string): number {
  return db.transaction(() => {
    const ids = (
      db
        .prepare(
          `SELECT annotation_id AS id FROM annotation_routing
           WHERE state = 'assigned' AND assigned_thread_id = ?`,
        )
        .all(threadId) as { id: string }[]
    ).map((row) => row.id);
    const restaged = stageAssigned(db, ids, { keepAcknowledged: false });
    db.prepare(`DELETE FROM annotation_turn_assignments WHERE thread_id = ?`).run(threadId);
    return restaged;
  })();
}

export interface TurnAssignmentRow {
  annotationId: string;
  threadId: string;
  updatedAt: string;
}

/**
 * What recovery checks, read before it looks threads up: every thread holding
 * a turn assignment or an assigned annotation, and the turn assignments then.
 */
export interface RecoverySnapshot {
  threadIds: string[];
  turnAssignments: TurnAssignmentRow[];
}

export function readRecoverySnapshot(db: Database): RecoverySnapshot {
  const threadIds = (
    db
      .prepare(
        `SELECT thread_id FROM annotation_turn_assignments
         UNION
         SELECT assigned_thread_id FROM annotation_routing
         WHERE state = 'assigned' AND assigned_thread_id IS NOT NULL
         ORDER BY 1`,
      )
      .all() as Array<{ thread_id: string }>
  ).map((row) => row.thread_id);
  const turnAssignments = (
    db
      .prepare(
        `SELECT annotation_id, thread_id, updated_at FROM annotation_turn_assignments
         ORDER BY thread_id, annotation_id`,
      )
      .all() as Array<{ annotation_id: string; thread_id: string; updated_at: string }>
  ).map((row) => ({
    annotationId: row.annotation_id,
    threadId: row.thread_id,
    updatedAt: row.updated_at,
  }));
  return { threadIds, turnAssignments };
}

export interface RecoveryResult {
  /** Pending annotations whose turn ended while the server was stopped. */
  restaged: number;
  /** Annotations, acknowledged or not, assigned to a thread that is gone. */
  orphaned: number;
  /** Threads still mid-turn whose turn assignments were kept. */
  keptThreads: number;
}

/**
 * Re-stage turn assignments the server lost track of while it was stopped
 * (restart, reload, plugin safe mode), from thread states looked up for
 * `snapshot`. Only turn assignments still as the snapshot read them are
 * touched, so an annotation sent while the lookups ran keeps its new turn.
 *
 * - A missing thread was deleted: everything assigned to it returns to staging.
 * - An active thread is still mid-turn: its assignments keep their phase, and
 *   the thread events that follow finish them as if the server never stopped.
 * - Any other thread's turn may have ended unseen: its pending assignments
 *   return to staging; acknowledged ones stay with the agent that took them.
 */
export function recoverInterruptedTurnAssignments(
  db: Database,
  snapshot: RecoverySnapshot,
  threads: { active?: ReadonlySet<string>; missing?: ReadonlySet<string> } = {},
): RecoveryResult {
  const active = threads.active ?? new Set<string>();
  const missing = threads.missing ?? new Set<string>();
  return db.transaction((): RecoveryResult => {
    const result: RecoveryResult = { restaged: 0, orphaned: 0, keptThreads: 0 };
    const unchanged = db.prepare(
      `SELECT 1 FROM annotation_turn_assignments
       WHERE annotation_id = ? AND thread_id = ? AND updated_at = ?`,
    );
    const forget = db.prepare(
      `DELETE FROM annotation_turn_assignments WHERE annotation_id = ? AND thread_id = ?`,
    );
    for (const threadId of snapshot.threadIds) {
      if (missing.has(threadId)) {
        result.orphaned += restageThreadAssignments(db, threadId);
        continue;
      }
      const rows = snapshot.turnAssignments.filter((row) => row.threadId === threadId);
      const ids = rows
        .filter((row) => unchanged.get(row.annotationId, row.threadId, row.updatedAt))
        .map((row) => row.annotationId);
      if (active.has(threadId)) {
        if (ids.length > 0) result.keptThreads += 1;
        continue;
      }
      result.restaged += stageAssigned(db, ids, { keepAcknowledged: true });
      for (const annotationId of ids) forget.run(annotationId, threadId);
    }
    return result;
  })();
}

export function failDispatch(db: Database, dispatchId: string, error: string): number {
  return db.transaction(() => {
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE annotation_routing
         SET state = 'staged', assigned_thread_id = NULL, dispatch_id = NULL,
             updated_at = ?
         WHERE dispatch_id = ? AND state = 'sending'
           AND annotation_id IN (
             SELECT id FROM annotations
             WHERE status IN ('pending', 'acknowledged')
           )`,
      )
      .run(timestamp, dispatchId);

    const closed = db
      .prepare(
        `DELETE FROM annotation_routing
         WHERE dispatch_id = ? AND state = 'sending'
           AND annotation_id IN (
             SELECT id FROM annotations
             WHERE status IN ('resolved', 'dismissed')
           )`,
      )
      .run(dispatchId);

    db.prepare(
      `UPDATE annotation_dispatches
       SET status = 'failed', error = ?, completed_at = ?
       WHERE id = ? AND status = 'sending'`,
    ).run(error, timestamp, dispatchId);
    return result.changes + closed.changes;
  })();
}

/** Re-stage claims left in flight by a plugin or server restart. */
export function recoverInterruptedDispatches(db: Database): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT dispatch_id
       FROM annotation_routing
       WHERE state = 'sending' AND dispatch_id IS NOT NULL`,
    )
    .all() as { dispatch_id: string }[];
  let recovered = 0;
  for (const row of rows) {
    recovered += failDispatch(
      db,
      row.dispatch_id,
      "Plugin restarted before delivery was confirmed",
    );
  }
  return recovered;
}

/**
 * Return an assigned annotation to staging, as the panel's **Stage again** and
 * `bb agentation restage` do. It is no longer anyone's, so an acknowledged one
 * returns to pending.
 */
export function restageAnnotation(db: Database, annotationId: string): AnnotationRouting | null {
  return db.transaction(() =>
    stageAssigned(db, [annotationId], { keepAcknowledged: false }) === 1
      ? getAnnotationRouting(db, annotationId)
      : null,
  )();
}
