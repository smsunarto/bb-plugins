import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";

import { diffEmbedSchema, type RenderEmbedInput } from "../../shared/contract.ts";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

type DiffInput = Extract<RenderEmbedInput, { kind: "diff" }>;
export type DiffSnapshot = z.output<typeof diffEmbedSchema>;

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

// Keep the original migration byte-for-byte: shipped databases hash statements.
export function snapshotDatabase(bb: BbPluginApi): Database {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    ...diffSnapshotMigrations,
    `CREATE TABLE smart_diff_snapshots_v2 (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  ]);
  return db;
}

export function snapshotKey(input: DiffInput): string {
  return JSON.stringify([
    input.threadId,
    input.messageId,
    input.path,
    input.start ?? 0,
    input.end ?? 0,
    input.source ?? null,
    input.sha ?? null,
    input.turnId ?? null,
    input.workspace ?? null,
  ]);
}

export function readDiffSnapshot(db: Database, input: DiffInput): DiffSnapshot | null {
  const row = db
    .prepare<[string], { payload: string }>(
      "SELECT payload FROM smart_diff_snapshots_v2 WHERE key = ?",
    )
    .get(snapshotKey(input));
  if (row) return decode(row.payload);
  // Old directives had no explicit source. Honour their already captured evidence.
  if (input.source || input.sha) return null;
  const old = db
    .prepare<unknown[], { payload: string }>(
      `SELECT payload FROM diff_snapshots WHERE thread_id = ? AND message_id = ? AND kind = ? AND path = ? AND start_line = ? AND end_line = ?`,
    )
    .get(input.threadId, input.messageId, "diff", input.path, input.start ?? 0, input.end ?? 0);
  return old ? decode(old.payload, true) : null;
}
function decode(payload: string, legacy = false): DiffSnapshot {
  // Rows saved before `files` carried their one file as `path` and `patch`.
  const { path, patch, files = [{ path, patch }], ...raw } = JSON.parse(payload);
  return diffEmbedSchema.parse(
    legacy
      ? {
          status: raw.status,
          kind: raw.kind,
          label: raw.label,
          files,
          truncated: raw.truncated,
          source: "Saved workspace diff",
        }
      : { ...raw, files },
  );
}
export function saveDiffSnapshot(
  db: Database,
  input: DiffInput,
  value: DiffSnapshot,
): DiffSnapshot {
  db.prepare("INSERT OR IGNORE INTO smart_diff_snapshots_v2 (key, payload) VALUES (?, ?)").run(
    snapshotKey(input),
    JSON.stringify(value),
  );
  return readDiffSnapshot(db, input)!;
}
