import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { renderEmbedOutputSchema, type RenderEmbedOutput } from "../../shared/contract.ts";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type DiffSnapshotKey = {
  threadId: string;
  messageId: string;
  kind: "diff";
  path: string;
  start?: number;
  end?: number;
};

type DiffSnapshot = Extract<RenderEmbedOutput, { status: "ready" }> & { kind: "diff" };

export const diffSnapshotMigrations = [
  `CREATE TABLE diff_snapshots (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'diff'),
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id, kind, path, start_line, end_line)
  )`,
];

function bindings(key: DiffSnapshotKey) {
  return [key.threadId, key.messageId, key.kind, key.path, key.start ?? 0, key.end ?? 0];
}

export function readDiffSnapshot(db: Database, key: DiffSnapshotKey): DiffSnapshot | null {
  const row = db
    .prepare<unknown[], { payload: string }>(
      `SELECT payload FROM diff_snapshots
       WHERE thread_id = ? AND message_id = ? AND kind = ? AND path = ?
         AND start_line = ? AND end_line = ?`,
    )
    .get(...bindings(key));
  if (row === undefined) return null;
  const value = renderEmbedOutputSchema.parse(JSON.parse(row.payload));
  if (value.status !== "ready" || value.kind !== "diff") {
    throw new Error("Invalid saved diff snapshot.");
  }
  return { ...value, kind: "diff" };
}

export function saveDiffSnapshot(
  db: Database,
  key: DiffSnapshotKey,
  value: DiffSnapshot,
): DiffSnapshot {
  db.prepare(
    `INSERT OR IGNORE INTO diff_snapshots
     (thread_id, message_id, kind, path, start_line, end_line, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(...bindings(key), JSON.stringify(value));
  const saved = readDiffSnapshot(db, key);
  if (saved === null) throw new Error("Could not save diff snapshot.");
  return saved;
}
