import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import type { AgentInstructionsContext } from "../lib/store.ts";

export function remove(ctx: AgentInstructionsContext) {
  return cliCommand({
    summary: "Delete an instruction rule",
    positionals: [{ name: "id", description: "Rule id from `list`", required: true }],
    async run({ positionals }) {
      await ctx.store.update((rules) => {
        if (!rules.some((rule) => rule.id === positionals.id)) {
          throw new PluginCliError(`No rule ${positionals.id}`, { code: "unknown_rule" });
        }
        return rules.filter((rule) => rule.id !== positionals.id);
      });
      return { exitCode: 0, stdout: `Removed ${positionals.id}\n` };
    },
  });
}
