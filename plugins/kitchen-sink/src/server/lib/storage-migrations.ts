import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Append new migrations. Shipped databases hash these statements at indices 0 and 1.
// The retired snapshots remain stored; removing their UI does not erase saved evidence.
export const storageMigrations = [
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
  `CREATE TABLE smart_diff_snapshots_v2 (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE sauce_lease (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`,
];

export function migrateStorage(bb: BbPluginApi): void {
  bb.storage.migrate(bb.storage.database(), storageMigrations);
}
