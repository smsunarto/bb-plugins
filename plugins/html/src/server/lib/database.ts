import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * One list for the plugin's one database: bb numbers migrations by index, so
 * append new statements and never reorder these.
 */
export const MIGRATIONS = [
  `CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    height INTEGER NOT NULL,
    html TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX pages_thread ON pages (thread_id)`,
  `CREATE TABLE widget_states (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    file TEXT NOT NULL,
    state TEXT NOT NULL,
    model_content TEXT,
    tweaks TEXT,
    saved_at TEXT NOT NULL,
    has_widget_state INTEGER NOT NULL CHECK(has_widget_state IN (0, 1)),
    UNIQUE(thread_id, message_id, file)
  )`,
  `CREATE INDEX widget_states_thread_recent ON widget_states(thread_id, sequence DESC)`,
  // State belongs only to published pages. Host-file state from the retired
  // file directive is dropped, and page keys lose their `html-render:` prefix.
  `DELETE FROM widget_states WHERE file NOT LIKE 'html-render:%'`,
  `UPDATE widget_states SET file = substr(file, 13)`,
  `ALTER TABLE widget_states RENAME COLUMN file TO page_id`,
];

export function openDatabase(bb: BbPluginApi): Database {
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
  return database;
}
