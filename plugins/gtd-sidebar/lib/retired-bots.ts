// Bots moved to their own plugin (`plugins/bots`). GTD Sidebar briefly stored
// them in its own database, so it keeps that schema and hands the rows to the
// Bots plugin once, which imports them into its own database.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The retired bot tables, in their original order after GTD's own and the
 * retired project migrations. bb applies one list per database by position,
 * so these stay in place; new GTD migrations go after them.
 */
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

/** The plugin allowed to read the export. */
const BOTS_PLUGIN_ID = "bots";

/** Parents before children, so the importer can insert in this order. */
const RETIRED_BOT_TABLES = [
  "bots",
  "bot_threads",
  "bot_state",
  "bot_starts",
  "bot_project_owners",
  "thread_completion",
  "thread_detached",
] as const;

const cellSchema = z.union([z.string(), z.number(), z.null()]);
export const retiredBotsExportSchema = z
  .object({
    tables: z.record(z.string(), z.array(z.record(z.string(), cellSchema))),
  })
  .strict();

export const retiredBotsRpcContract = defineRpcContract({
  retired_bots_export: {
    experimental_description:
      "The bot rows GTD Sidebar stored before Bots became its own plugin. Only the Bots plugin may call it.",
    input: z.object({}).strict(),
    output: retiredBotsExportSchema,
  },
});

export function registerRetiredBotsExport(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.rpc.register(retiredBotsRpcContract, {
    retired_bots_export: (_input, ctx) => {
      const caller = ctx.experimental_caller;
      if (caller.kind !== "plugin" || caller.pluginId !== BOTS_PLUGIN_ID)
        throw new Error("Only the Bots plugin can read GTD Sidebar's retired bot data");
      const tables: Record<string, Record<string, string | number | null>[]> = {};
      for (const table of RETIRED_BOT_TABLES)
        tables[table] = db.prepare(`SELECT * FROM ${table}`).all() as Record<
          string,
          string | number | null
        >[];
      return { tables };
    },
  });
}
