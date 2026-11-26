import { cliCommand } from "@get-bb/plugin-sdk";
import type { AgentInstructionsContext } from "../lib/context.ts";
import { callerHost } from "../lib/targets.ts";

export function pathCommand(ctx: AgentInstructionsContext) {
  return cliCommand({
    summary: "Print the editable agent-instructions folder path on this machine (or --host)",
    options: {
      host: {
        type: "string",
        placeholder: "host-id",
        description: "Target host id. Defaults to the calling thread's host, or the server host",
      },
      json: { type: "boolean", description: "Print the result as JSON" },
    },
    async run({ options }, context) {
      const hostId = options.host ?? (await callerHost(ctx.bb, context.threadId));
      const resolved = await ctx.sync.editablePathForHost(hostId);
      if (options.json) {
        return { exitCode: 0, stdout: `${JSON.stringify(resolved, null, 2)}\n` };
      }
      return { exitCode: 0, stdout: `${resolved.path}\n` };
    },
  });
}
