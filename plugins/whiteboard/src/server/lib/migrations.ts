import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Plugin-owned tables (design §3.10). Append-only: never reorder or edit a
 * shipped statement. Upstream tables come from the store constructor's DDL.
 */
export const MIGRATIONS: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS repository_hosts(repository_id TEXT PRIMARY KEY, host_id TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS session_threads(session_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY(session_id, thread_id))",
];

/** Run the plugin migrations on the plugin database. Idempotent across loads. */
export function migrate(bb: BbPluginApi): void {
  bb.storage.migrate(bb.storage.database(), [...MIGRATIONS]);
}
