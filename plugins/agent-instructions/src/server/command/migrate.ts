import { cliCommand } from "@get-bb/plugin-sdk";
import { formatMigrationReport, runMigration } from "../../source/migrate.ts";
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
        description: "Overwrite an existing non-empty source folder",
      },
      json: { type: "boolean", description: "Print the migration report as JSON" },
    },
    async run({ options }) {
      const report = await ctx.store.withLock(async () => {
        // Explicit CLI migration fails loudly on unreadable legacy KV state rather than dropping rules silently.
        const data = await ctx.store.readLegacyData({ lenient: false });
        const result = await runMigration({
          data,
          targetDir: ctx.store.sourceDir,
          tmpDir: ctx.store.tmpDir,
          markerPath: ctx.store.markerPath,
          apply: options.apply === true,
          force: options.force === true,
        });
        if (result.applied) {
          ctx.store.clearMigrationBlocked();
          ctx.store.restartWatch();
          await ctx.store.reloadUnlocked("disk");
        }
        return result;
      });

      if (report.applied) {
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
