// Retired Cursor Projects schema. Preserve statement order for existing databases.
// These tables are no longer read or written by the plugin.
export const RETIRED_PROJECT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS initiative (
     id                     TEXT PRIMARY KEY,
     name                   TEXT NOT NULL,
     icon                   TEXT NOT NULL DEFAULT '',
     description            TEXT NOT NULL DEFAULT '',
     coordinator_thread_id  TEXT NOT NULL,
     primary_environment_id TEXT,
     provider_id            TEXT,
     model                  TEXT,
     reasoning_level        TEXT,
     created_at             INTEGER NOT NULL,
     updated_at             INTEGER NOT NULL,
     archived_at            INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS initiative_coordinator
     ON initiative (coordinator_thread_id)`,
  `CREATE TABLE IF NOT EXISTS initiative_workspace (
     initiative_id TEXT NOT NULL,
     project_id    TEXT NOT NULL,
     position      INTEGER NOT NULL,
     PRIMARY KEY (initiative_id, project_id)
   )`,
  `CREATE INDEX IF NOT EXISTS initiative_workspace_project
     ON initiative_workspace (project_id)`,
  `CREATE TABLE IF NOT EXISTS initiative_context_doc (
     initiative_id TEXT NOT NULL,
     path          TEXT NOT NULL,
     content       TEXT NOT NULL,
     revision      INTEGER NOT NULL,
     size_bytes    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     updated_by    TEXT,
     PRIMARY KEY (initiative_id, path)
   )`,

  `CREATE TABLE IF NOT EXISTS initiative_subscriptions (
     id                 TEXT PRIMARY KEY,
     initiative_id      TEXT NOT NULL,
     kind               TEXT NOT NULL,
     config             TEXT NOT NULL,
     enabled            INTEGER NOT NULL DEFAULT 1,
     next_run_at        INTEGER,
     last_run_at        INTEGER,
     last_status        TEXT,
     last_error         TEXT,
     cursor             TEXT,
     retry_after_until  INTEGER,
     delivery_attempts  INTEGER NOT NULL DEFAULT 0,
     created_at         INTEGER NOT NULL,
     updated_at         INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS initiative_subscriptions_due
     ON initiative_subscriptions (enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS initiative_subscription_deliveries (
     subscription_id TEXT NOT NULL,
     event_id        TEXT NOT NULL,
     delivered_at    INTEGER NOT NULL,
     PRIMARY KEY (subscription_id, event_id)
   )`,
  `ALTER TABLE initiative_subscriptions ADD COLUMN label TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE initiative_subscriptions ADD COLUMN prompt TEXT`,
  `ALTER TABLE initiative_subscriptions ADD COLUMN poll_interval_ms INTEGER`,

  `ALTER TABLE initiative ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'legacy'`,
  `ALTER TABLE initiative ADD COLUMN shared_host_id TEXT`,
  `ALTER TABLE initiative ADD COLUMN shared_root_path TEXT`,
  `ALTER TABLE initiative_workspace ADD COLUMN host_id TEXT`,
  `ALTER TABLE initiative_workspace ADD COLUMN path TEXT`,
];
