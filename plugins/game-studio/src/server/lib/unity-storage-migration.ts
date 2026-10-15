import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
const migration = "unity-plugin-v1";
const tables = {
  unity_editor_claims: ["key", "host", "workspace", "record"],
  unity_checkout_slots: [
    "id",
    "host",
    "workspace",
    "project",
    "state",
    "owner",
    "lease",
    "reason",
    "updated",
  ],
  unity_slot_seeds: ["operation", "slot", "result"],
  unity_editor_migrations: ["id"],
};

/** The old namespace is read only; imported rows and the receipt commit together. */
export function importUnityStorage(db: Db, dataDir: string) {
  if (db.prepare("SELECT id FROM unity_editor_migrations WHERE id = ?").get(migration)) return;
  const path = join(dataDir, "plugins", "unity", "data.db");
  if (!existsSync(path)) return;
  const source = new Database(path, { readonly: true, fileMustExist: true });
  try {
    source.transaction(() =>
      db
        .transaction(() => {
          for (const [table, columns] of Object.entries(tables)) {
            if (
              !source
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get(table)
            )
              continue;
            const insert = db.prepare(
              `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            );
            for (const row of source
              .prepare(`SELECT ${columns.join(",")} FROM ${table}`)
              .all() as Record<string, unknown>[]) {
              insert.run(...columns.map((column) => row[column]));
            }
          }
          // Match the stores' reload semantics after transferring interrupted work.
          db.prepare(
            "DELETE FROM unity_editor_claims WHERE json_extract(record, '$.jobId') = 'verifying'",
          ).run();
          db.prepare(
            "UPDATE unity_editor_claims SET record = json_set(record, '$.jobId', 'uncertain') WHERE json_extract(record, '$.jobId') = 'submitting'",
          ).run();
          db.prepare(
            "UPDATE unity_checkout_slots SET state = 'quarantined', reason = ?, updated = ? WHERE state IN ('preparing','seeding','releasing')",
          ).run(
            "Checkout verification was interrupted; explicit recovery is required",
            new Date().toISOString(),
          );
          db.prepare("INSERT INTO unity_editor_migrations (id) VALUES (?)").run(migration);
        })
        .immediate(),
    )();
  } finally {
    source.close();
  }
}

export async function ensureUnityStorage(bb: BbPluginApi, db: Db) {
  const { plugins } = await bb.sdk.plugins.list();
  if (plugins.some((plugin) => plugin.id === "unity" && plugin.enabled)) {
    throw new Error("Disable the separate Unity plugin before using Game Studio's Unity tools.");
  }
  importUnityStorage(db, bb.server.experimental_dataDir);
}

/** Scope dispatch before the lazy handoff, without depending on the old plugin's RPCs. */
export function legacyUnitySlotPaths(bb: BbPluginApi, hostId: string): string[] {
  if (
    bb.storage
      .database()
      .prepare("SELECT id FROM unity_editor_migrations WHERE id = ?")
      .get(migration)
  )
    return [];
  const path = join(bb.server.experimental_dataDir, "plugins", "unity", "data.db");
  if (!existsSync(path)) return [];
  const source = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (
      !source
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("unity_checkout_slots")
    )
      return [];
    return (
      source.prepare("SELECT workspace FROM unity_checkout_slots WHERE host = ?").all(hostId) as {
        workspace: string;
      }[]
    ).map((row) => row.workspace);
  } finally {
    source.close();
  }
}
