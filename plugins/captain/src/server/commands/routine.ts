import { cliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import type { Routine, RoutineRun, RoutineView, Schedule } from "../../contract/routines.ts";
import { readCallerFile, routineCaptain, routineThreadAllowed } from "../caller.ts";
import { guard, Refusal, render, type Item } from "../output.ts";
import type { RoutineOwner } from "../routines.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

/**
 * `bb captain routine …`: scheduled messages to a Captain. The user, or the
 * Captain on the user's request, manages them; crew threads are refused.
 */

const ROUTINE = {
  name: "routine",
  required: true,
  description: "The routine's id, such as r3, or its name",
} as const;

const SCHEDULE_OPTIONS = {
  cron: {
    type: "string",
    placeholder: "cron",
    description:
      'Five-field cron, such as "0 9 * * 1-5" for weekdays at 9:00; at most every 15 minutes',
  },
  timezone: {
    type: "string",
    placeholder: "iana",
    description: "The cron's IANA time zone, such as Europe/Berlin; defaults to the bb server's",
  },
  in: {
    type: "string",
    placeholder: "duration",
    description: "Run once after this long, such as 90m, 2h or 1d",
  },
  at: {
    type: "string",
    placeholder: "iso-time",
    description: "Run once at this ISO 8601 time, such as 2026-11-20T09:00:00Z",
  },
} as const;

const DURATION = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/u;

/** `90m`, `2h`, `1h30m`, `1d` in milliseconds, or null. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text.trim());
  if (match === null || match.slice(1).every((part) => part === undefined)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  const ms = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return ms > 0 ? ms : null;
}

type ScheduleInput = { cron?: string; timezone?: string; in?: string; at?: string };

/** The schedule the options name, or null when they name none. */
function scheduleFrom(
  deps: CommandDeps,
  options: ScheduleInput,
  fallbackTimezone: string | null,
): Schedule | null {
  const given = [options.cron, options.in, options.at].filter((value) => value !== undefined);
  if (given.length > 1) {
    throw new Refusal([
      { reason: "--cron, --in and --at each set the schedule", fix: "pass one of them" },
    ]);
  }
  if (options.in !== undefined) {
    const ms = parseDuration(options.in);
    if (ms === null)
      throw new Refusal([
        { reason: `cannot read --in ${options.in}`, fix: "pass a duration such as 90m, 2h or 1d" },
      ]);
    return { at: deps.now() + ms };
  }
  if (options.at !== undefined) {
    const at = Date.parse(options.at);
    if (Number.isNaN(at))
      throw new Refusal([
        { reason: `cannot read --at ${options.at}`, fix: "pass an ISO 8601 time with its offset" },
      ]);
    return { at };
  }
  if (options.cron !== undefined) {
    return {
      cron: options.cron,
      timezone: options.timezone ?? fallbackTimezone ?? serverTimezone(),
    };
  }
  if (options.timezone !== undefined) {
    throw new Refusal([{ reason: "--timezone sets a cron's zone", fix: "pass --cron with it" }]);
  }
  return null;
}

function serverTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The Captain a routine command acts for, after refusing crew. */
async function owner(
  deps: CommandDeps,
  ctx: PluginCliContext,
  captainOption: string | undefined,
): Promise<RoutineOwner> {
  const captain = await routineCaptain(deps.bb, deps.registry, deps.store, ctx, captainOption);
  return { threadId: captain.threadId, name: captain.name, homeProjectId: captain.homeProjectId };
}

/**
 * The routine a command names: by id or name within the calling Captain. From
 * a shell with no thread and no `--captain`, a bare id still finds it.
 */
async function named(
  deps: CommandDeps,
  ctx: PluginCliContext,
  address: string,
  captainOption: string | undefined,
): Promise<Routine> {
  if (ctx.threadId === undefined && captainOption === undefined) {
    const routine = deps.store.routine(address);
    if (routine !== null) return routine;
  }
  const captain = await owner(deps, ctx, captainOption);
  const routine = deps.store.findRoutine(captain.threadId, address);
  if (routine !== null) return routine;
  throw new Refusal([
    {
      reason: `${captain.name} Captain has no routine ${JSON.stringify(address)}`,
      fix: "bb captain routine list",
    },
  ]);
}

async function instructionFrom(
  deps: CommandDeps,
  ctx: PluginCliContext,
  path: string | undefined,
): Promise<string | undefined> {
  return path === undefined ? undefined : await readCallerFile(deps.bb, ctx, path);
}

/** A time in the routine's zone, as the Captain repeats it to the user. */
export function formatAt(at: number, timezone: string | undefined): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timezone === undefined ? {} : { timeZone: timezone }),
  }).format(new Date(at));
}

function zoneOf(view: RoutineView): string | undefined {
  return "timezone" in view.schedule ? view.schedule.timezone : undefined;
}

/** A one-shot whose time came: Automations disables it after its run. */
function state(view: RoutineView): string {
  if (view.done) return "done";
  if (view.missed) return "missed";
  if (view.automation === null) return "unavailable";
  return view.automation.enabled ? "active" : "paused";
}

function next(view: RoutineView): string {
  if (view.done) return "ran once";
  if (view.missed)
    return `its one run was ${view.lastRun?.reason ?? "not delivered"}; give it a new time`;
  if (view.automation === null) return view.automationError ?? "schedule unavailable";
  if (!view.automation.enabled) return "paused";
  return view.automation.nextRunAt === null
    ? "no next run"
    : `next ${formatAt(view.automation.nextRunAt, zoneOf(view))}`;
}

function when(view: RoutineView): string {
  const zone = zoneOf(view);
  return zone === undefined ? view.when : `${view.when} (${zone})`;
}

function runLine(run: RoutineRun, timezone: string | undefined): string {
  const reason = run.reason === null ? "" : `: ${run.reason}`;
  return `${formatAt(run.at, timezone)}  ${run.trigger}  ${run.status}${reason}`;
}

function viewItem(view: RoutineView, itemState: string, ok = true): Item {
  return {
    id: view.id,
    ok,
    state: itemState,
    detail: [JSON.stringify(view.name), when(view), next(view)].join("  "),
    data: {
      name: view.name,
      when: view.when,
      schedule: view.schedule,
      enabled: view.automation?.enabled ?? null,
      nextRunAt: view.automation?.nextRunAt ?? null,
      automationId: view.automationId,
      automationError: view.automationError,
      lastRun: view.lastRun,
    },
  };
}

export function routineAddCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Add a routine: a message the Captain gets on a schedule",
    description:
      "Prints the schedule in words and the next run. A new routine waits for its next time; run it now with bb captain routine run.",
    options: {
      name: {
        type: "string",
        required: true,
        placeholder: "name",
        description: "At most 80 characters, unique per Captain",
      },
      ...SCHEDULE_OPTIONS,
      "prompt-file": {
        type: "string",
        required: true,
        placeholder: "path",
        description:
          "The instruction for each run: a UTF-8 file on the invoking machine, at most 4000 characters",
      },
      paused: { type: "boolean", description: "Create it paused" },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain routine add", json, async () => {
        const captain = await owner(deps, ctx, input.options.captain);
        const schedule = scheduleFrom(deps, input.options, null);
        if (schedule === null) {
          throw new Refusal([
            { reason: "a routine needs a schedule", fix: "pass --cron, --in or --at" },
          ]);
        }
        const instruction = (await instructionFrom(deps, ctx, input.options["prompt-file"])) ?? "";
        const view = await deps.routines.create(
          captain,
          { name: input.options.name, instruction, schedule },
          { paused: input.options.paused === true },
        );
        return render([viewItem(view, "added")], json);
      });
    },
  });
}

export function routineUpdateCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Change a routine's name, schedule or instruction",
    positionals: [ROUTINE],
    options: {
      name: { type: "string", placeholder: "name", description: "A new name" },
      ...SCHEDULE_OPTIONS,
      "prompt-file": {
        type: "string",
        placeholder: "path",
        description: "A new instruction, from this file",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain routine update", json, async () => {
        const routine = await named(deps, ctx, input.positionals.routine, input.options.captain);
        const current = "timezone" in routine.schedule ? routine.schedule : null;
        // A new --timezone alone moves the current cron to that zone.
        const scheduleInput =
          input.options.timezone !== undefined &&
          input.options.cron === undefined &&
          current !== null
            ? { ...input.options, cron: current.cron }
            : input.options;
        const schedule = scheduleFrom(deps, scheduleInput, current?.timezone ?? null);
        const instruction = await instructionFrom(deps, ctx, input.options["prompt-file"]);
        if (input.options.name === undefined && schedule === null && instruction === undefined) {
          throw new Refusal([
            {
              reason: "nothing to change",
              fix: "pass --name, --cron, --in, --at, --timezone or --prompt-file",
            },
          ]);
        }
        const view = await deps.routines.update(routine, {
          ...(input.options.name === undefined ? {} : { name: input.options.name }),
          ...(schedule === null ? {} : { schedule }),
          ...(instruction === undefined ? {} : { instruction }),
        });
        return render([viewItem(view, "updated")], json);
      });
    },
  });
}

export function routineListCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "List the Captain's routines with their schedule and next run",
    options: { captain: CAPTAIN_OPTION, json: JSON_OPTION },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain routine list", json, async () => {
        const captain = await owner(deps, ctx, input.options.captain);
        const views = await deps.routines.list(captain.threadId);
        if (views.length === 0 && !json) {
          return { exitCode: 0, stdout: `${captain.name} Captain has no routines\n` };
        }
        return render(
          views.map((view) => viewItem(view, state(view))),
          json,
        );
      });
    },
  });
}

export function routineShowCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Show one routine: its instruction, when it runs and, with --runs, its last runs",
    positionals: [ROUTINE],
    options: {
      runs: { type: "boolean", description: "Add its last 20 runs, newest first" },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain routine show", json, async () => {
        const routine = await named(deps, ctx, input.positionals.routine, input.options.captain);
        const view = await deps.routines.view(routine);
        const runs = input.options.runs === true ? deps.store.routineRuns(routine.id) : [];
        if (json) {
          const item = viewItem(view, state(view));
          return render(
            [{ ...item, data: { ...item.data, instruction: view.instruction, runs } }],
            json,
          );
        }
        const lines = [
          `${view.id}  ${state(view)}  ${JSON.stringify(view.name)}`,
          `When to run: ${when(view)}; ${next(view)}`,
          `Last run: ${view.lastRun === null ? "none yet" : runLine(view.lastRun, zoneOf(view))}`,
          "Instruction:",
          view.instruction,
          ...(input.options.runs === true
            ? [
                "Runs:",
                ...(runs.length === 0
                  ? ["none yet"]
                  : runs.map((run) => runLine(run, zoneOf(view)))),
              ]
            : []),
        ];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      });
    },
  });
}

function actionCommand(
  deps: CommandDeps,
  action: "pause" | "resume" | "run" | "remove",
  summary: string,
) {
  return cliCommand({
    summary,
    positionals: [ROUTINE],
    options: { captain: CAPTAIN_OPTION, json: JSON_OPTION },
    run(input, ctx) {
      const json = input.options.json;
      return guard(`captain routine ${action}`, json, async () => {
        const routine = await named(deps, ctx, input.positionals.routine, input.options.captain);
        const result = await deps.routines.act(routine, action === "remove" ? "delete" : action);
        if (result.view === null) {
          return render(
            [{ id: routine.id, ok: true, state: "removed", detail: JSON.stringify(routine.name) }],
            json,
          );
        }
        if (action === "run") {
          const item = viewItem(result.view, "running");
          return render(
            [
              {
                ...item,
                detail: `${JSON.stringify(routine.name)}  test run ${result.runId ?? ""} started; the Captain gets it in a few seconds`,
                data: { ...item.data, runId: result.runId },
              },
            ],
            json,
          );
        }
        return render([viewItem(result.view, action === "pause" ? "paused" : "active")], json);
      });
    },
  });
}

export const routinePauseCommand = (deps: CommandDeps) =>
  actionCommand(deps, "pause", "Pause a routine; it keeps its schedule");
export const routineResumeCommand = (deps: CommandDeps) =>
  actionCommand(deps, "resume", "Resume a paused routine from its next time");
export const routineRunCommand = (deps: CommandDeps) =>
  actionCommand(deps, "run", "Run a routine now, as a test; a test run does real work");
export const routineRemoveCommand = (deps: CommandDeps) =>
  actionCommand(deps, "remove", "Delete a routine and its schedule");

export function routineFireCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Deliver one routine run to its Captain (called by the routine's automation)",
    description:
      "Each routine's automation calls this. To run a routine yourself, use bb captain routine run.",
    hidden: true,
    positionals: [{ name: "routine", required: true, description: "The routine id" }],
    options: {
      automation: {
        type: "string",
        required: true,
        placeholder: "id",
        description: "The calling automation's id",
      },
      run: { type: "string", placeholder: "id", description: "The calling automation run's id" },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain routine fire", json, async () => {
        const routine = deps.store.routine(input.positionals.routine);
        // A thread-bound call is refused unless it is the routine's own Captain.
        await routineThreadAllowed(
          deps.bb,
          deps.registry,
          deps.store,
          ctx,
          routine?.captainId ?? "",
        );
        if (routine !== null) {
          const named = input.options.captain?.trim();
          const owner = deps.store.captain(routine.captainId);
          if (
            named !== undefined &&
            named !== routine.captainId &&
            named.toLowerCase() !== owner?.name.toLowerCase()
          ) {
            throw new Refusal([
              {
                reason: `${routine.id} belongs to ${owner?.name ?? routine.captainId} Captain, not ${JSON.stringify(named)}`,
                fix: "drop --captain or pass the routine's Captain",
              },
            ]);
          }
        }
        const result = await deps.routines.fire(input.positionals.routine, {
          automationId: input.options.automation,
          runId:
            input.options.run === undefined || input.options.run === "" ? null : input.options.run,
        });
        return render(
          [
            {
              id: input.positionals.routine,
              ok: true,
              state: result.state,
              detail: `${result.run.trigger}${result.run.reason === null ? "" : `  ${result.run.reason}`}`,
              data: { run: result.run },
            },
          ],
          json,
        );
      });
    },
  });
}
