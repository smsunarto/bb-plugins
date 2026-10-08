import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import type { RuleStore } from "../lib/store.ts";
import { describeConditions, loadTargets } from "../lib/targets.ts";

export const list = defineCommand({
  summary: "List the instruction rules in the order they are applied",
  options: { json: { type: "boolean", description: "Print the rules as JSON" } },
  async execute(ctx: CommandContext<Context<{ store: RuleStore }>>, { options }) {
    const { rules } = ctx.store.state();
    if (options.json) return { exitCode: 0, stdout: `${JSON.stringify({ rules }, null, 2)}\n` };
    if (rules.length === 0) return { exitCode: 0, stdout: "No rules yet\n" };
    const targets = await loadTargets(ctx.bb);
    const lines = rules.map((rule) => {
      const title = rule.name.trim() || rule.instructions.trim().split("\n")[0] || "(empty)";
      const state = rule.enabled ? "" : " [off]";
      return `${rule.id}${state}  ${title}\n  when ${describeConditions(rule.when, targets)}`;
    });
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  },
});
