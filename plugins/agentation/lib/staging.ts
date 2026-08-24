// Authoritative routing state for Agentation annotations.
//
// Annotation lifecycle (pending, acknowledged, resolved, dismissed) remains in
// the annotation store. This module owns the independent routing lifecycle:
// staged -> sending -> assigned. Callers never infer a delivery target from the
// page where feedback was captured.

import type DatabaseNamespace from "better-sqlite3";

import type { AnnotationRouting, StoredAnnotation } from "./afs.ts";
import { setAnnotationStatus } from "./store.ts";

type Database = DatabaseNamespace.Database;

export type AnnotationRoutingState = "staged" | "sending" | "assigned";

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
  state: AnnotationRoutingState;
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

function toRouting(row: RoutingRow): AnnotationRouting {
  return {
    annotationId: row.annotation_id,
    state: row.state,
    assignedThreadId: row.assigned_thread_id,
    dispatchId: row.dispatch_id,
    updatedAt: row.updated_at,
  };
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
 * Atomically discard the exact staged snapshot a banner displayed.
 *
 * A concurrent send or discard makes the request stale and changes nothing.
 * Feedback staged after the banner rendered is not part of the requested ids,
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
 * Atomically claim the exact snapshot a banner displayed.
 *
 * A second pane gets `stale` if any requested item is no longer staged. New
 * annotations that were not in this snapshot remain staged for a later send.
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
        `SELECT a.id, a.payload
         FROM annotation_routing r
         JOIN annotations a ON a.id = r.annotation_id
         WHERE r.annotation_id IN (${placeholders})
           AND r.state = 'staged'
           AND a.status IN ('pending', 'acknowledged')`,
      )
      .all(...uniqueIds) as { id: string; payload: string }[];
    if (rows.length !== uniqueIds.length) return { outcome: "stale" };

    const byId = new Map(rows.map((row) => [row.id, row.payload]));
    const annotations = uniqueIds.map((id) => readAnnotation(byId.get(id)!));
    const id = `dsp_${crypto.randomUUID()}`;
    const timestamp = nowIso();

    db.prepare(
      `INSERT INTO annotation_dispatches
         (id, thread_id, status, annotation_ids, error, created_at, completed_at)
       VALUES (?, ?, 'sending', ?, NULL, ?, NULL)`,
    ).run(id, input.threadId, JSON.stringify(uniqueIds), timestamp);

    const update = db.prepare(
      `UPDATE annotation_routing
       SET state = 'sending', assigned_thread_id = ?, dispatch_id = ?, updated_at = ?
       WHERE annotation_id = ? AND state = 'staged'`,
    );
    for (const annotationId of uniqueIds) {
      const result = update.run(input.threadId, id, timestamp, annotationId);
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
         SET state = 'assigned', updated_at = ?
         WHERE dispatch_id = ? AND state = 'sending'`,
      )
      .run(timestamp, dispatchId);
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
           AND r.assigned_thread_id IS NOT NULL
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

export function restageTurnAssignments(
  db: Database,
  threadId: string,
  options: { includeAwaitingStart?: boolean } = {},
): number {
  return db.transaction(() => {
    const timestamp = nowIso();
    const phaseClause = options.includeAwaitingStart ? "" : "AND t.phase = 'awaiting-finish'";
    const result = db
      .prepare(
        `UPDATE annotation_routing
         SET state = 'staged', assigned_thread_id = NULL, dispatch_id = NULL,
             updated_at = ?
         WHERE annotation_id IN (
           SELECT t.annotation_id
           FROM annotation_turn_assignments t
           JOIN annotations a ON a.id = t.annotation_id
           WHERE t.thread_id = ? ${phaseClause}
             AND a.status IN ('pending', 'acknowledged')
         )
           AND state = 'assigned'`,
      )
      .run(timestamp, threadId);

    db.prepare(
      `DELETE FROM annotation_turn_assignments
       WHERE thread_id = ? ${options.includeAwaitingStart ? "" : "AND phase = 'awaiting-finish'"}`,
    ).run(threadId);
    return result.changes;
  })();
}

export function recoverInterruptedTurnAssignments(db: Database): number {
  return db.transaction(() => {
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE annotation_routing
         SET state = 'staged', assigned_thread_id = NULL, dispatch_id = NULL,
             updated_at = ?
         WHERE state = 'assigned'
           AND annotation_id IN (
             SELECT t.annotation_id
             FROM annotation_turn_assignments t
             JOIN annotations a ON a.id = t.annotation_id
             WHERE a.status IN ('pending', 'acknowledged')
           )`,
      )
      .run(timestamp);
    db.prepare(`DELETE FROM annotation_turn_assignments`).run();
    return result.changes;
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

export function restageAnnotation(db: Database, annotationId: string): AnnotationRouting | null {
  return db.transaction(() => {
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE annotation_routing
         SET state = 'staged', assigned_thread_id = NULL, dispatch_id = NULL,
             updated_at = ?
         WHERE annotation_id = ? AND state = 'assigned'
           AND EXISTS (
             SELECT 1 FROM annotations
             WHERE id = ? AND status IN ('pending', 'acknowledged')
           )`,
      )
      .run(timestamp, annotationId, annotationId);
    if (result.changes === 1) {
      db.prepare(`DELETE FROM annotation_turn_assignments WHERE annotation_id = ?`).run(
        annotationId,
      );
    }
    return result.changes === 1 ? getAnnotationRouting(db, annotationId) : null;
  })();
}
