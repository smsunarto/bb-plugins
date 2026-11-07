import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** GTD Sidebar stored bots in its own database before Bots became a plugin. */
const GTD_PLUGIN_ID = "gtd-sidebar";
const DONE_KEY = "import:gtd-sidebar";

/**
 * Every column each retired GTD table may hold, parents first. Only these
 * names reach the INSERT, so the export cannot name another table or column.
 */
const TABLE_COLUMNS = {
  bots: ["id", "data"],
  bot_threads: ["thread_id", "bot_id"],
  bot_state: ["key", "data"],
  bot_starts: ["token", "bot_id", "created_at", "project_id"],
  bot_project_owners: ["project_id", "bot_id", "assigned_at"],
  thread_completion: ["thread_id", "completed_at", "reopened_at"],
  thread_detached: ["thread_id", "detached_at"],
} as const satisfies Record<string, readonly string[]>;

const cellSchema = z.union([z.string(), z.number(), z.null()]);
const exportSchema = z.object({
  tables: z.record(z.string(), z.array(z.record(z.string(), cellSchema))),
});
type Export = z.infer<typeof exportSchema>;

export type GtdImportResult =
  | { kind: "done"; rows: number }
  | { kind: "nothing" }
  | { kind: "retry"; reason: string };

/** Copies the export's rows, keeping any row this plugin already has. Returns the rows copied. */
export function importRows(db: ReturnType<BbPluginApi["storage"]["database"]>, data: Export) {
  let rows = 0;
  db.transaction(() => {
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      const statement = db.prepare(
        `INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      for (const row of data.tables[table] ?? [])
        rows += statement.run(...columns.map((column) => row[column] ?? null)).changes;
    }
    db.prepare(
      "INSERT INTO bot_state(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
    ).run(DONE_KEY, JSON.stringify({ importedAt: Date.now(), rows }));
  }).immediate();
  return rows;
}

/**
 * Imports GTD Sidebar's bots once. With GTD absent there is nothing to import;
 * with GTD installed but not serving yet, the caller retries.
 */
export async function importFromGtdSidebar(bb: BbPluginApi): Promise<GtdImportResult> {
  const db = bb.storage.database();
  if (db.prepare("SELECT 1 FROM bot_state WHERE key = ?").get(DONE_KEY)) return { kind: "nothing" };
  const { plugins } = await bb.sdk.plugins.list();
  const gtd = plugins.find((plugin) => plugin.id === GTD_PLUGIN_ID);
  if (!gtd) {
    importRows(db, { tables: {} });
    return { kind: "nothing" };
  }
  if (!gtd.enabled || gtd.status !== "running")
    return { kind: "retry", reason: `GTD Sidebar is ${gtd.enabled ? gtd.status : "disabled"}` };
  const data = await bb.sdk.plugins.callRpc({
    pluginId: GTD_PLUGIN_ID,
    method: "retired_bots_export",
    input: {},
    outputSchema: exportSchema,
  });
  return { kind: "done", rows: importRows(db, data) };
}

/** Runs the import in the background with a bounded retry; the next load tries again. */
export function startGtdImport(bb: BbPluginApi, onImported: () => void) {
  const delays = [0, 5_000, 30_000, 120_000];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const attempt = (index: number) => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const result = await importFromGtdSidebar(bb);
        if (result.kind === "done") {
          bb.log.info(`Imported ${result.rows} bot rows from GTD Sidebar`);
          onImported();
          return;
        }
        if (result.kind === "nothing") return;
        if (index + 1 < delays.length) attempt(index + 1);
        else bb.log.warn(`Bots import from GTD Sidebar postponed: ${result.reason}`);
      } catch (error) {
        if (index + 1 < delays.length) attempt(index + 1);
        else
          bb.log.warn(
            `Bots import from GTD Sidebar failed: ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    }, delays[index]);
  };
  attempt(0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
