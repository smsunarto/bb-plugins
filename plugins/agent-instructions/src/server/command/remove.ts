import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import type { RuleStore } from "../lib/store.ts";

export const remove = defineCommand({
  summary: "Delete an instruction rule",
  positionals: [{ name: "id", description: "Rule id from `list`", required: true }],
  async execute(ctx: CommandContext<Context<{ store: RuleStore }>>, { positionals }) {
    await ctx.store.update((rules) => {
      if (!rules.some((rule) => rule.id === positionals.id)) {
        throw new PluginCliError(`No rule ${positionals.id}`, { code: "unknown_rule" });
      }
      return rules.filter((rule) => rule.id !== positionals.id);
    });
    return { exitCode: 0, stdout: `Removed ${positionals.id}\n` };
  },
});
