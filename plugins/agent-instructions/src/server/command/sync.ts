import { cliCommand } from "@get-bb/plugin-sdk";
import type { AgentInstructionsContext } from "../lib/context.ts";

export function syncCommand(ctx: AgentInstructionsContext) {
  return cliCommand({
    summary: "Reconcile the server source folder with connected host editable mirrors",
    options: {
      host: {
        type: "string",
        placeholder: "host-id",
        description: "Reconcile only this connected remote host (defaults to all connected hosts)",
      },
      json: { type: "boolean", description: "Print the sync status as JSON" },
    },
    async run({ options }) {
      await ctx.store.reloadFromDisk("disk");
      const hosts = await ctx.sync.syncNowAll(options.host);
      const conflicts = ctx.store.conflicts();
      const failed = hosts.filter((h) => h.lastError !== null);
      const exitCode = failed.length > 0 ? 1 : 0;
      if (options.json) {
        return {
          exitCode,
          stdout: `${JSON.stringify({ sourcePath: ctx.store.sourceDir, hosts, conflicts }, null, 2)}\n`,
        };
      }
      const lines = [
        `Source: ${ctx.store.sourceDir}`,
        ...(hosts.length === 0
          ? [
              options.host
                ? `Mirrors: host ${options.host} is not a connected remote host`
                : "Mirrors: no connected remote hosts",
            ]
          : hosts.map(
              (h) =>
                `Mirror ${h.hostName} (${h.hostId}): ${
                  h.lastError ? `error — ${h.lastError}` : (h.mirrorDir ?? "synced")
                }`,
            )),
        ...(conflicts.length > 0
          ? [`Conflicts (${conflicts.length}):`, ...conflicts.map((c) => `  ${c}`)]
          : []),
      ];
      return { exitCode, stdout: `${lines.join("\n")}\n` };
    },
  });
}
