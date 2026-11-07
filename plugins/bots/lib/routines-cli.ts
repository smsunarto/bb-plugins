import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import type { BotStore } from "./bot-store.ts";
import type { Routines } from "./routines.ts";

const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
// oxlint-disable-next-line no-control-regex -- strips terminal control characters from names
const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const fail = (error: unknown): never => {
  if (error instanceof PluginCliError) throw error;
  throw new PluginCliError(error instanceof Error ? error.message : String(error), {
    code: "routines_failed",
  });
};

/** `bb bots routines list|run|fire`. Agents in a bot's conversation use the routine tools instead. */
export function routineCliCommands(store: BotStore, routines: Routines) {
  const list = cliCommand({
    summary: "List bots' routines with their schedule, state, and conversation",
    options: {
      json: JSON_OPTION,
      bot: { type: "string", description: "Only this bot's routines (bot ID)" },
    },
    async run({ options }) {
      try {
        const bots = options.bot ? [store.require(options.bot)] : store.list();
        const views = (await Promise.all(bots.map((bot) => routines.listViews(bot.id)))).flat();
        const names = new Map(bots.map((bot) => [bot.id, bot.name]));
        return {
          exitCode: 0,
          stdout: options.json
            ? JSON.stringify({ routines: views })
            : [
                "ROUTINE ID\tBOT\tNAME\tSCHEDULE\tSTATE\tNEXT RUN\tCONVERSATION",
                ...views.map((routine) =>
                  [
                    routine.id,
                    printable(names.get(routine.botId) ?? routine.botId),
                    printable(routine.name),
                    `${routine.cron} (${routine.timezone})`,
                    routine.automation
                      ? routine.automation.enabled
                        ? "active"
                        : "paused"
                      : "unavailable",
                    routine.automation?.nextRunAt
                      ? new Date(routine.automation.nextRunAt).toISOString()
                      : "—",
                    routine.threadId ?? "Starts on first run",
                  ].join("\t"),
                ),
                `${views.length} routines.`,
              ].join("\n"),
        };
      } catch (error) {
        return fail(error);
      }
    },
  });
  const run = cliCommand({
    summary: "Run a routine now through Automations, as its Test button does",
    positionals: [{ name: "routine", description: "Routine ID", required: true }],
    options: { json: JSON_OPTION },
    async run({ positionals, options }) {
      try {
        const result = await routines.act(positionals.routine, "run");
        return {
          exitCode: result.run?.status === "failed" ? 1 : 0,
          stdout: options.json
            ? JSON.stringify(result)
            : `Routine run ${result.run?.id ?? ""} ${result.run?.status ?? "running"}${result.run?.error ? ` (${result.run.error})` : ""}. Automations finishes it in the background; bb bots routines list shows the outcome.`,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });
  const fire = cliCommand({
    summary: "Deliver one routine run to its conversation (called by the routine's automation)",
    description:
      "Each routine's automation calls this on schedule. To run a routine yourself, use bb bots routines run so the run is recorded.",
    hidden: true,
    positionals: [{ name: "routine", description: "Routine ID", required: true }],
    options: {
      json: JSON_OPTION,
      automation: { type: "string", description: "The calling automation's ID" },
    },
    async run({ positionals, options }) {
      try {
        const result = await routines.fire(positionals.routine, options.automation || undefined);
        return {
          exitCode: 0,
          stdout: options.json
            ? JSON.stringify(result)
            : `${result.delivery === "started" ? "Started" : result.delivery === "queued" ? "Queued in" : "Sent to"} conversation ${result.threadId}.`,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });
  return { "routines list": list, "routines run": run, "routines fire": fire };
}
