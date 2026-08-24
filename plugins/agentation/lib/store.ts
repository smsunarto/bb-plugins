// SQLite store for annotation sessions.
//
// Every function here is pure with respect to the plugin API: it takes a
// better-sqlite3 handle and nothing else, so the whole store is unit-testable
// against an in-memory database.
//
// The annotation row keeps the complete `StoredAnnotation` in `payload` and
// mirrors only the queryable fields into columns. Reads therefore never
// reassemble an object from columns, and a newer `agentation` release that
// adds context fields round-trips untouched.

import type DatabaseNamespace from "better-sqlite3";
import {
  type Annotation,
  type AnnotationStatus,
  type BbContext,
  type Session,
  type SessionStatus,
  type SessionSummary,
  type StoredAnnotation,
  isClosed,
  sanitizeJson,
} from "./afs.ts";

type Database = DatabaseNamespace.Database;

export const migrations: string[] = [
  `CREATE TABLE IF NOT EXISTS counters (
     name TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     url TEXT NOT NULL,
     route TEXT NOT NULL,
     title TEXT,
     status TEXT NOT NULL DEFAULT 'active',
     thread_id TEXT,
     project_id TEXT,
     mutation_seq INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS annotations (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     status TEXT NOT NULL,
     kind TEXT NOT NULL,
     intent TEXT,
     severity TEXT,
     comment TEXT NOT NULL,
     element TEXT NOT NULL,
     element_path TEXT NOT NULL,
     plugin_id TEXT,
     route TEXT NOT NULL,
     thread_id TEXT,
     project_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     payload TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS annotations_session_idx ON annotations (session_id)`,
  `CREATE INDEX IF NOT EXISTS annotations_status_idx ON annotations (status)`,
  `CREATE INDEX IF NOT EXISTS annotations_seq_idx ON annotations (seq)`,
  `CREATE INDEX IF NOT EXISTS sessions_route_idx ON sessions (route)`,
  `CREATE TABLE IF NOT EXISTS annotation_routing (
     annotation_id TEXT PRIMARY KEY,
     state TEXT NOT NULL CHECK (state IN ('staged', 'sending', 'assigned')),
     assigned_thread_id TEXT,
     dispatch_id TEXT,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS annotation_routing_state_idx
     ON annotation_routing (state, updated_at)`,
  `CREATE TABLE IF NOT EXISTS annotation_dispatches (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
     annotation_ids TEXT NOT NULL,
     error TEXT,
     created_at TEXT NOT NULL,
     completed_at TEXT
   )`,
  `INSERT OR IGNORE INTO annotation_routing
     (annotation_id, state, assigned_thread_id, dispatch_id, updated_at)
   SELECT id, 'staged', NULL, NULL, updated_at
   FROM annotations
   WHERE status IN ('pending', 'acknowledged')`,
  `CREATE TRIGGER IF NOT EXISTS annotations_stage_after_insert
   AFTER INSERT ON annotations
   WHEN NEW.status IN ('pending', 'acknowledged')
   BEGIN
     INSERT OR IGNORE INTO annotation_routing
       (annotation_id, state, assigned_thread_id, dispatch_id, updated_at)
     VALUES (NEW.id, 'staged', NULL, NULL, NEW.updated_at);
   END`,
  `CREATE TRIGGER IF NOT EXISTS annotations_restage_after_reopen
   AFTER UPDATE OF status ON annotations
   WHEN OLD.status IN ('resolved', 'dismissed')
     AND NEW.status IN ('pending', 'acknowledged')
   BEGIN
     INSERT INTO annotation_routing
       (annotation_id, state, assigned_thread_id, dispatch_id, updated_at)
     VALUES (NEW.id, 'staged', NULL, NULL, NEW.updated_at)
     ON CONFLICT(annotation_id) DO UPDATE SET
       state = 'staged',
       assigned_thread_id = NULL,
       dispatch_id = NULL,
       updated_at = excluded.updated_at;
   END`,
  `CREATE TRIGGER IF NOT EXISTS annotations_routing_after_delete
   AFTER DELETE ON annotations
   BEGIN
     DELETE FROM annotation_routing WHERE annotation_id = OLD.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS annotations_unstage_after_close
   AFTER UPDATE OF status ON annotations
   WHEN OLD.status IN ('pending', 'acknowledged')
     AND NEW.status IN ('resolved', 'dismissed')
   BEGIN
     DELETE FROM annotation_routing
     WHERE annotation_id = NEW.id AND state = 'staged';
   END`,
  `CREATE TABLE IF NOT EXISTS annotation_turn_assignments (
     annotation_id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     phase TEXT NOT NULL CHECK (phase IN ('awaiting-start', 'awaiting-finish')),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS annotation_turn_assignments_thread_idx
     ON annotation_turn_assignments (thread_id, phase, updated_at)`,
  `CREATE TRIGGER IF NOT EXISTS annotations_turn_assignment_after_delete
   AFTER DELETE ON annotations
   BEGIN
     DELETE FROM annotation_turn_assignments WHERE annotation_id = OLD.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS annotations_unassign_after_close
   AFTER UPDATE OF status ON annotations
   WHEN OLD.status IN ('pending', 'acknowledged')
     AND NEW.status IN ('resolved', 'dismissed')
   BEGIN
     DELETE FROM annotation_turn_assignments WHERE annotation_id = NEW.id;
     DELETE FROM annotation_routing
     WHERE annotation_id = NEW.id AND state = 'assigned';
   END`,
];

function nowIso(): string {
  return new Date().toISOString();
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function nextSeq(db: Database): number {
  db.prepare(
    `INSERT INTO counters (name, value) VALUES ('seq', 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
  ).run();
  const row = db.prepare(`SELECT value FROM counters WHERE name = 'seq'`).get() as
    | { value: number }
    | undefined;
  return row?.value ?? 1;
}

export function currentSeq(db: Database): number {
  const row = db.prepare(`SELECT value FROM counters WHERE name = 'seq'`).get() as
    | { value: number }
    | undefined;
  return row?.value ?? 0;
}

type SessionRow = {
  id: string;
  url: string;
  route: string;
  title: string | null;
  status: string;
  thread_id: string | null;
  project_id: string | null;
  mutation_seq: number;
  created_at: string;
  updated_at: string;
};

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    url: row.url,
    route: row.route,
    title: row.title,
    status: row.status as SessionStatus,
    threadId: row.thread_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface OpenSessionInput {
  url: string;
  route: string;
  title: string | null;
  threadId: string | null;
  projectId: string | null;
}

/**
 * Join the active session for a route, or start one. Two bb windows showing
 * the same route deliberately share a session so the agent sees one
 * conversation rather than a fragmented pair.
 */
export function openSession(db: Database, input: OpenSessionInput): Session {
  const existing = db
    .prepare(
      `SELECT * FROM sessions
       WHERE route = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(input.route) as SessionRow | undefined;

  const timestamp = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE sessions
       SET url = ?, title = COALESCE(?, title), thread_id = ?, project_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.url, input.title, input.threadId, input.projectId, timestamp, existing.id);
    return toSession({
      ...existing,
      url: input.url,
      title: input.title ?? existing.title,
      thread_id: input.threadId,
      project_id: input.projectId,
      updated_at: timestamp,
    });
  }

  const id = `ses_${randomSuffix()}`;
  db.prepare(
    `INSERT INTO sessions
       (id, url, route, title, status, thread_id, project_id, mutation_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.url,
    input.route,
    input.title,
    input.threadId,
    input.projectId,
    nextSeq(db),
    timestamp,
    timestamp,
  );

  return {
    id,
    url: input.url,
    route: input.route,
    title: input.title,
    status: "active",
    threadId: input.threadId,
    projectId: input.projectId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function getSession(db: Database, sessionId: string): Session | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
  return row ? toSession(row) : null;
}

function touchSession(db: Database, sessionId: string): number {
  const seq = nextSeq(db);
  db.prepare(`UPDATE sessions SET mutation_seq = ?, updated_at = ? WHERE id = ?`).run(
    seq,
    nowIso(),
    sessionId,
  );
  return seq;
}

/** Highest write cursor a client could have observed for one session. */
export function sessionCursor(db: Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT MAX(value) AS cursor FROM (
         SELECT mutation_seq AS value FROM sessions WHERE id = ?
         UNION ALL
         SELECT seq AS value FROM annotations WHERE session_id = ?
       )`,
    )
    .get(sessionId, sessionId) as { cursor: number | null } | undefined;
  return row?.cursor ?? 0;
}

export function listSessions(
  db: Database,
  options: { status?: SessionStatus; limit?: number } = {},
): SessionSummary[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    clauses.push(`s.status = ?`);
    params.push(options.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? 200);

  const rows = db
    .prepare(
      `SELECT s.*,
              COUNT(a.id) AS total,
              SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN a.status = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
              SUM(CASE WHEN a.status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN a.status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
              MAX(a.created_at) AS last_annotation_at
       FROM sessions s
       LEFT JOIN annotations a ON a.session_id = s.id
       ${where}
       GROUP BY s.id
       ORDER BY COALESCE(MAX(a.created_at), s.updated_at) DESC
       LIMIT ?`,
    )
    .all(...params) as (SessionRow & {
    total: number;
    pending: number | null;
    acknowledged: number | null;
    resolved: number | null;
    dismissed: number | null;
    last_annotation_at: string | null;
  })[];

  return rows.map((row) =>
    Object.assign(toSession(row), {
      counts: {
        total: row.total ?? 0,
        pending: row.pending ?? 0,
        acknowledged: row.acknowledged ?? 0,
        resolved: row.resolved ?? 0,
        dismissed: row.dismissed ?? 0,
      },
      lastAnnotationAt: row.last_annotation_at,
    }),
  );
}

function readAnnotation(payload: string): StoredAnnotation {
  return JSON.parse(payload) as StoredAnnotation;
}

function writeAnnotation(db: Database, annotation: StoredAnnotation): void {
  db.prepare(
    `INSERT INTO annotations
       (id, session_id, seq, status, kind, intent, severity, comment, element,
        element_path, plugin_id, route, thread_id, project_id, created_at,
        updated_at, payload)
     VALUES (@id, @session_id, @seq, @status, @kind, @intent, @severity, @comment,
             @element, @element_path, @plugin_id, @route, @thread_id, @project_id,
             @created_at, @updated_at, @payload)
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       seq = excluded.seq,
       status = excluded.status,
       kind = excluded.kind,
       intent = excluded.intent,
       severity = excluded.severity,
       comment = excluded.comment,
       element = excluded.element,
       element_path = excluded.element_path,
       plugin_id = excluded.plugin_id,
       route = excluded.route,
       thread_id = excluded.thread_id,
       project_id = excluded.project_id,
       updated_at = excluded.updated_at,
       payload = excluded.payload`,
  ).run({
    id: annotation.id,
    session_id: annotation.sessionId,
    seq: annotation.seq,
    status: annotation.status,
    kind: annotation.kind,
    intent: annotation.intent ?? null,
    severity: annotation.severity ?? null,
    comment: annotation.comment,
    element: annotation.element,
    element_path: annotation.elementPath,
    plugin_id: annotation.bb.pluginId,
    route: annotation.bb.route,
    thread_id: annotation.bb.threadId,
    project_id: annotation.bb.projectId,
    created_at: annotation.createdAt,
    updated_at: annotation.updatedAt,
    payload: JSON.stringify(annotation),
  });
}

export function getAnnotation(db: Database, annotationId: string): StoredAnnotation | null {
  const row = db.prepare(`SELECT payload FROM annotations WHERE id = ?`).get(annotationId) as
    | { payload: string }
    | undefined;
  return row ? readAnnotation(row.payload) : null;
}

export interface UpsertAnnotationInput {
  sessionId: string;
  annotation: Annotation;
  bb: BbContext;
}

/**
 * Record an annotation the toolbar just created or edited.
 *
 * The human owns the annotation body; the agent owns the lifecycle. So an edit
 * arriving from the browser refreshes the comment and captured context but
 * never rewinds a status the agent already advanced, and never drops the reply
 * thread.
 */
export function upsertAnnotation(db: Database, input: UpsertAnnotationInput): StoredAnnotation {
  const existing = getAnnotation(db, input.annotation.id);
  const timestamp = nowIso();
  const incoming = sanitizeJson(input.annotation);

  const stored: StoredAnnotation = {
    ...existing,
    ...incoming,
    id: input.annotation.id,
    sessionId: input.sessionId,
    status: existing?.status ?? incoming.status ?? "pending",
    kind: incoming.kind ?? existing?.kind ?? "feedback",
    thread: existing?.thread ?? [],
    // Captured once, when the annotation was first placed. A later edit comes
    // from the comment box, not from clicking the element again, so re-reading
    // the browser's "last clicked" context would overwrite a good location
    // with wherever the caret happened to be.
    bb: existing?.bb ?? input.bb,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    resolution: existing?.resolution ?? null,
    seq: nextSeq(db),
  };

  writeAnnotation(db, stored);
  return stored;
}

export interface SetStatusInput {
  annotationId: string;
  status: AnnotationStatus;
  by: "human" | "agent";
  resolution?: string | null;
}

export function setAnnotationStatus(db: Database, input: SetStatusInput): StoredAnnotation | null {
  const existing = getAnnotation(db, input.annotationId);
  if (!existing) return null;

  const timestamp = nowIso();
  const stored: StoredAnnotation = {
    ...existing,
    status: input.status,
    resolution: input.resolution === undefined ? existing.resolution : input.resolution,
    updatedAt: timestamp,
    seq: nextSeq(db),
  };

  if (isClosed(input.status)) {
    stored.resolvedAt = timestamp;
    stored.resolvedBy = input.by;
  } else {
    delete stored.resolvedAt;
    delete stored.resolvedBy;
  }

  writeAnnotation(db, stored);
  return stored;
}

export function appendThreadMessage(
  db: Database,
  annotationId: string,
  message: { role: "human" | "agent"; content: string },
): StoredAnnotation | null {
  const existing = getAnnotation(db, annotationId);
  if (!existing) return null;

  const stored: StoredAnnotation = {
    ...existing,
    thread: [
      ...existing.thread,
      {
        id: `msg_${randomSuffix()}`,
        role: message.role,
        content: message.content,
        timestamp: Date.now(),
      },
    ],
    updatedAt: nowIso(),
    seq: nextSeq(db),
  };

  writeAnnotation(db, stored);
  return stored;
}

export function deleteAnnotations(db: Database, annotationIds: string[]): number {
  if (annotationIds.length === 0) return 0;
  const sessionIds = new Set<string>();
  for (const id of annotationIds) {
    const row = db.prepare(`SELECT session_id FROM annotations WHERE id = ?`).get(id) as
      | { session_id: string }
      | undefined;
    if (row) sessionIds.add(row.session_id);
  }

  const placeholders = annotationIds.map(() => "?").join(", ");
  const result = db
    .prepare(`DELETE FROM annotations WHERE id IN (${placeholders})`)
    .run(...annotationIds);

  // A delete leaves no row to carry a cursor, so the session has to record it
  // or clients would never notice the removal.
  for (const sessionId of sessionIds) touchSession(db, sessionId);
  return result.changes;
}

export function clearSession(db: Database, sessionId: string): number {
  const result = db.prepare(`DELETE FROM annotations WHERE session_id = ?`).run(sessionId);
  touchSession(db, sessionId);
  return result.changes;
}

export interface ListAnnotationsFilter {
  sessionId?: string;
  statuses?: AnnotationStatus[];
  pluginId?: string;
  route?: string;
  sinceSeq?: number;
  /** `null` requests the complete result; omitted retains the review cap. */
  limit?: number | null;
}

export function listAnnotations(
  db: Database,
  filter: ListAnnotationsFilter = {},
): StoredAnnotation[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.sessionId) {
    clauses.push(`session_id = ?`);
    params.push(filter.sessionId);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }
  if (filter.pluginId) {
    clauses.push(`plugin_id = ?`);
    params.push(filter.pluginId);
  }
  if (filter.route) {
    clauses.push(`route = ?`);
    params.push(filter.route);
  }
  if (typeof filter.sinceSeq === "number") {
    clauses.push(`seq > ?`);
    params.push(filter.sinceSeq);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limitClause = filter.limit === null ? "" : " LIMIT ?";
  if (filter.limit !== null) params.push(filter.limit ?? 500);

  const rows = db
    .prepare(
      `SELECT payload FROM annotations ${where} ORDER BY created_at ASC, seq ASC${limitClause}`,
    )
    .all(...params) as { payload: string }[];

  return rows.map((row) => readAnnotation(row.payload));
}

export function countByStatus(db: Database): Record<AnnotationStatus, number> & { total: number } {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS count FROM annotations GROUP BY status`)
    .all() as { status: AnnotationStatus; count: number }[];

  const counts = {
    pending: 0,
    acknowledged: 0,
    resolved: 0,
    dismissed: 0,
    total: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
    counts.total += row.count;
  }
  return counts;
}

/**
 * Drop closed annotations, and any session left with nothing in it, older than
 * the retention window. The browser toolbar forgets local annotations after
 * seven days; keeping the server side unbounded would only accumulate rows no
 * client can still see.
 */
export function pruneClosed(db: Database, retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare(
      `DELETE FROM annotations
       WHERE status IN ('resolved', 'dismissed') AND updated_at < ?`,
    )
    .run(cutoff);
  db.prepare(
    `DELETE FROM sessions
     WHERE updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM annotations WHERE session_id = sessions.id)`,
  ).run(cutoff);
  return result.changes;
}
