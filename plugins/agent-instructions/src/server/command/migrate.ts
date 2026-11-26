import { cliCommand } from "@get-bb/plugin-sdk";
import {
  formatMigrationReport,
  openReadOnlySqlite,
  readLegacyRulesFile,
  readLegacySqlite,
  runMigration,
  type LegacyData,
} from "../../source/migrate.ts";
import type { AgentInstructionsContext } from "../lib/context.ts";

export function migrateCommand(ctx: AgentInstructionsContext) {
  return cliCommand({
    summary: "Export the legacy SQLite catalog and KV rules to plain files (dry-run by default)",
    options: {
      apply: {
        type: "boolean",
        description: "Write the exported files and verify them on disk",
      },
      force: {
        type: "boolean",
        description: "Overwrite an existing non-empty target source folder",
      },
      "source-db": {
        type: "string",
        placeholder: "path",
        description: "Path to a SQLite data.db copy (defaults to this plugin's data.db)",
      },
      "source-rules-json": {
        type: "string",
        placeholder: "path",
        description: "Path to a JSON file containing legacy rules (defaults to plugin KV state)",
      },
      target: {
        type: "string",
        placeholder: "dir",
        description: "Target source folder (defaults to this plugin's source/ directory)",
      },
      json: { type: "boolean", description: "Print the migration report as JSON" },
    },
    async run({ options }) {
      let data: LegacyData;
      if (options["source-db"] || options["source-rules-json"]) {
        const sqlite = options["source-db"]
          ? await (async () => {
              const opened = await openReadOnlySqlite(options["source-db"]!);
              try {
                return readLegacySqlite(opened.db);
              } finally {
                opened.close();
              }
            })()
          : { docs: [], skills: [], deleted: [] };
        const rules = options["source-rules-json"]
          ? await readLegacyRulesFile(options["source-rules-json"])
          : [];
        data = { ...sqlite, rules };
      } else {
        data = await ctx.store.readLegacyData();
      }

      const targetDir = options.target ?? ctx.store.sourceDir;
      const isDefaultTarget = options.target === undefined;
      const report = await runMigration({
        data,
        targetDir,
        tmpDir: ctx.store.tmpDir,
        markerPath: isDefaultTarget ? ctx.store.markerPath : undefined,
        apply: options.apply === true,
        force: options.force === true,
      });

      if (report.applied && isDefaultTarget) {
        await ctx.store.reloadFromDisk("disk");
        await ctx.publisher.run();
      }

      const exitCode = report.verification.ok ? 0 : 1;
      const stdout = options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatMigrationReport(report);
      return { exitCode, stdout };
    },
  });
}
