import type { BbPluginApi } from "@get-bb/plugin-sdk";

// One append-only migration ledger for both workflows. The first two shipped with Arena.
export function database(bb: Pick<BbPluginApi, "storage">) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE arena_runs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, request_id TEXT NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(parent, request_id))",
    "CREATE INDEX arena_runs_parent ON arena_runs(parent)",
    "CREATE TABLE review_runs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)",
  ]);
  return db;
}
