// Retired Bots tables, no longer read. bb applies migrations by position, so keep them in order.
export const RETIRED_BOT_MIGRATIONS = [
  "CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE bot_threads (thread_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id))",
  "CREATE TABLE bot_state (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE bot_starts (token TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), created_at INTEGER NOT NULL)",
  "CREATE TABLE bot_project_owners (project_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, assigned_at INTEGER NOT NULL)",
  "CREATE INDEX bot_project_owners_by_bot ON bot_project_owners(bot_id)",
  "ALTER TABLE bot_starts ADD COLUMN project_id TEXT",
  "CREATE TABLE thread_completion (thread_id TEXT PRIMARY KEY, completed_at INTEGER, reopened_at INTEGER)",
  "CREATE TABLE thread_detached (thread_id TEXT PRIMARY KEY, detached_at INTEGER NOT NULL)",
];
