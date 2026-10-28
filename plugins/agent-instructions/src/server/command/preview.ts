import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import { compose, MAX_INSTRUCTIONS_LENGTH } from "../../shared/rules.ts";
import type { AgentInstructionsContext } from "../lib/store.ts";
import { describeConditions, loadTargets } from "../lib/targets.ts";

export function preview(ctx: AgentInstructionsContext) {
  return cliCommand({
    summary: "Print the instructions these rules give a thread's agent right now",
    options: {
      thread: {
        type: "string",
        description: "Thread id. Defaults to the calling thread",
        placeholder: "id",
      },
    },
    async run({ options }, cli) {
      const threadId = options.thread ?? cli.threadId;
      if (!threadId) {
        throw new PluginCliError("Pass --thread or run inside a bb thread", { code: "no_thread" });
      }
      const session = ctx.store.lastSession(threadId);
      if (!session) {
        throw new PluginCliError(`No agent session seen for ${threadId} since this plugin loaded`, {
          code: "no_session",
          hint: "Send the thread a message, then retry.",
        });
      }
      const header = describeConditions(
        {
          hosts: [session.host.id],
          providers: [session.provider.id],
          models: [session.provider.model],
          projects: [session.project.id],
        },
        await loadTargets(ctx.bb),
      );
      const text = compose(ctx.store.state().rules, session);
      if (text === null) return { exitCode: 0, stdout: `${header}\n\n(no rule matches)\n` };
      // bb cuts a plugin's instructions here, so show only what the agent gets.
      const delivered = text.slice(0, MAX_INSTRUCTIONS_LENGTH);
      const cut =
        text.length > MAX_INSTRUCTIONS_LENGTH
          ? `\n\n(truncated: the agent gets ${MAX_INSTRUCTIONS_LENGTH} of ${text.length} characters)`
          : "";
      return { exitCode: 0, stdout: `${header}\n\n${delivered}${cut}\n` };
    },
  });
}
