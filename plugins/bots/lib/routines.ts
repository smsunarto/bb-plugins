import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { z } from "zod";
import type { BotMetadata } from "../contract.ts";
import {
  ROUTINES_PER_BOT,
  routineSchema,
  type Routine,
  type RoutineAction,
  type RoutineFields,
  type RoutineRun,
  type RoutineView,
} from "./routine-schema.ts";

const files = instructionFiles(import.meta.url);

/** The automations plugin that schedules routines and keeps their run history. */
export const AUTOMATIONS_PLUGIN_ID = "automations";
const AUTOMATION_DEADLINE_MS = 8000;
/**
 * The stored script each routine's automation runs on the bb server. It hands
 * the run back to this plugin, which owns the conversation and the message.
 *
 * Automations (bb 0.49) sets BB_SERVER_URL from its own environment and falls
 * back to the default port, ignoring BB_SERVER_PORT, so on a server started
 * with only --server-port the script would call another bb. Prefer the port
 * this server listens on when the URL is that fallback.
 */
export const ROUTINE_SCRIPT = [
  'case "${BB_SERVER_URL:-}" in',
  '  ""|http://127.0.0.1:38886) [ -n "${BB_SERVER_PORT:-}" ] && BB_SERVER_URL="http://127.0.0.1:$BB_SERVER_PORT" ;;',
  "esac",
  "export BB_SERVER_URL",
  'exec bb bots routines fire "$BB_BOT_ROUTINE_ID" --automation "${BB_AUTOMATION_ID:-}"',
  "",
].join("\n");

const automationStatus = z.looseObject({
  id: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastRunStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  runCount: z.number(),
});
const automationRun = z.looseObject({
  id: z.string(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  trigger: z.enum(["schedule", "manual"]),
  error: z.string().nullable(),
  skipReason: z.string().nullable(),
  output: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});

/** The automations RPC a routine needs. Tests replace the plugin behind `callRpc`. */
export function createAutomationsClient(bb: BbPluginApi) {
  const call = <T>(method: string, input: unknown, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({
      pluginId: AUTOMATIONS_PLUGIN_ID,
      method,
      input: input as never,
      outputSchema,
      signal: AbortSignal.timeout(AUTOMATION_DEADLINE_MS),
    });
  const target = (routine: Routine) => ({
    projectId: routine.projectId,
    automationId: routine.automationId,
  });
  const name = (bot: BotMetadata, routine: Pick<Routine, "name">) =>
    `${bot.name} · ${routine.name}`.slice(0, 200);
  const trigger = (routine: Pick<Routine, "cron" | "timezone">) => ({
    triggerType: "schedule" as const,
    cron: routine.cron,
    timezone: routine.timezone,
  });
  return {
    create: (
      bot: BotMetadata,
      routine: Routine,
      createdByThreadId: string | null,
      enabled = true,
    ) =>
      call(
        "automations_create",
        {
          projectId: routine.projectId,
          name: name(bot, routine),
          enabled,
          trigger: trigger(routine),
          execution: {
            mode: "script",
            script: ROUTINE_SCRIPT,
            interpreter: "sh",
            timeoutMs: 60_000,
            env: { BB_BOT_ROUTINE_ID: routine.id },
            workingDirectory: { type: "automation-storage" },
          },
          origin: createdByThreadId ? "agent" : "app",
          ...(createdByThreadId ? { createdByThreadId } : {}),
        },
        automationStatus,
      ),
    update: (bot: BotMetadata, routine: Routine) =>
      call(
        "automations_update",
        { ...target(routine), name: name(bot, routine), trigger: trigger(routine) },
        automationStatus,
      ),
    get: (routine: Routine) => call("automations_get", target(routine), automationStatus),
    pause: (routine: Routine) => call("automations_pause", target(routine), automationStatus),
    resume: (routine: Routine) => call("automations_resume", target(routine), automationStatus),
    run: (routine: Routine) =>
      call("automations_run", target(routine), z.looseObject({ run: automationRun })),
    runs: (routine: Routine, limit: number) =>
      call(
        "automations_runs",
        { ...target(routine), limit },
        z.looseObject({ runs: z.array(automationRun) }),
      ),
    delete: (routine: Routine) =>
      call("automations_delete", target(routine), z.looseObject({ ok: z.literal(true) })),
  };
}
export type AutomationsClient = ReturnType<typeof createAutomationsClient>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const missing = (error: unknown) => /not found|no automation|does not exist/i.test(message(error));

export function validTimezone(timezone: string) {
  try {
    return Boolean(new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions());
  } catch {
    return false;
  }
}

/** Starts a routine's subthread under the bot's main chat, bound to its bot. Returns the new thread id. */
export type StartRoutineConversation = (args: {
  bot: BotMetadata;
  routine: Routine;
  text: string;
  parentThreadId: string;
}) => Promise<string>;

export function createRoutines(
  bb: BbPluginApi,
  deps: {
    automations: AutomationsClient;
    requireBot: (botId: string) => BotMetadata;
    /** The projects a routine may run in: Personal (run in the bot's home project) plus the bot's linked projects. */
    allowedProjectIds: (bot: BotMetadata) => Promise<string[]>;
    /** Whether a conversation in `threadProjectId` runs in the routine's project; a Personal routine runs in the bot's home. */
    runsIn: (
      bot: BotMetadata,
      routineProjectId: string,
      threadProjectId: string,
    ) => Promise<boolean>;
    resolveOwner: (threadId: string, persist?: boolean) => Promise<string | null>;
    /** The bot's main chat, started when it has none: every routine's parent. */
    mainChatId: (bot: BotMetadata) => Promise<string>;
    startConversation: StartRoutineConversation;
    publish: () => void;
  },
) {
  const db = bb.storage.database();
  const decode = (data: string) => routineSchema.parse(JSON.parse(data));
  const get = (id: string): Routine | null => {
    const row = db.prepare("SELECT data FROM bot_routines WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? decode(row.data) : null;
  };
  const require = (id: string) => {
    const routine = get(id);
    if (!routine) throw new Error("Routine not found. List routines for current IDs.");
    return routine;
  };
  const list = (botId: string): Routine[] =>
    (
      db.prepare("SELECT data FROM bot_routines WHERE bot_id = ? ORDER BY rowid").all(botId) as {
        data: string;
      }[]
    ).map((row) => decode(row.data));
  const all = (): Routine[] =>
    (db.prepare("SELECT data FROM bot_routines ORDER BY rowid").all() as { data: string }[]).map(
      (row) => decode(row.data),
    );
  const save = (routine: Routine) => {
    const value = routineSchema.parse(routine);
    db.prepare(
      "INSERT INTO bot_routines(id,bot_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(value.id, value.botId, JSON.stringify(value));
    return value;
  };
  const remove = (id: string) => db.prepare("DELETE FROM bot_routines WHERE id = ?").run(id);

  const locks = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    locks.set(key, run);
    void run
      .finally(() => {
        if (locks.get(key) === run) locks.delete(key);
      })
      .catch(() => {});
    return run;
  }

  async function view(routine: Routine): Promise<RoutineView> {
    if (!routine.automationId)
      return {
        ...routine,
        automation: null,
        automationError: "This routine has no schedule. Save it to schedule it again.",
      };
    try {
      const automation = await deps.automations.get(routine);
      return {
        ...routine,
        automation: {
          enabled: automation.enabled,
          nextRunAt: automation.nextRunAt,
          lastRunAt: automation.lastRunAt,
          lastRunStatus: automation.lastRunStatus,
          lastError: automation.lastError,
          runCount: automation.runCount,
        },
        automationError: null,
      };
    } catch (error) {
      return {
        ...routine,
        automation: null,
        automationError: missing(error)
          ? "Its automation was deleted. Save the routine to schedule it again."
          : `Automations is unavailable: ${message(error)}`,
      };
    }
  }

  async function validate(bot: BotMetadata, fields: RoutineFields) {
    if (!validTimezone(fields.timezone))
      throw new Error(
        `Unknown timezone ${fields.timezone}. Use an IANA name like America/New_York.`,
      );
    if (!(await deps.allowedProjectIds(bot)).includes(fields.projectId))
      throw new Error("Run routines in the bot's home project or one of its linked projects.");
  }

  async function create(botId: string, fields: RoutineFields, createdByThreadId: string | null) {
    return serial(`bot:${botId}`, async () => {
      const bot = deps.requireBot(botId);
      if (list(botId).length >= ROUTINES_PER_BOT)
        throw new Error(`A bot can have at most ${ROUTINES_PER_BOT} routines. Delete one first.`);
      await validate(bot, fields);
      const now = Date.now();
      const draft: Routine = {
        id: `routine_${randomUUID().replaceAll("-", "")}`,
        botId,
        ...fields,
        automationId: null,
        threadId: null,
        createdAt: now,
        updatedAt: now,
      };
      // Nothing is stored until the schedule exists, so a failed create leaves no orphan row.
      const automation = await deps.automations.create(bot, draft, createdByThreadId);
      const saved = save({ ...draft, automationId: automation.id });
      deps.publish();
      return view(saved);
    });
  }

  /**
   * Replaces the routine's automation, keeping its paused state. The old one is
   * deleted first so two schedules never fire the same routine; if creating the
   * replacement then fails, the routine is left without one and says so.
   */
  async function replaceAutomation(bot: BotMetadata, previous: Routine, next: Routine) {
    let enabled = true;
    if (previous.automationId) {
      try {
        enabled = (await deps.automations.get(previous)).enabled;
        await deps.automations.delete(previous);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      save({ ...latest(previous.id), automationId: null, updatedAt: Date.now() });
    }
    const automation = await deps.automations.create(bot, next, null, enabled);
    return automation.id;
  }
  const latest = (routineId: string) => require(routineId);

  async function update(routineId: string, fields: Partial<RoutineFields>) {
    return serial(`routine:${routineId}`, async () => {
      const routine = require(routineId);
      const bot = deps.requireBot(routine.botId);
      const next: Routine = { ...routine, ...fields };
      await validate(bot, next);
      const moved = next.projectId !== routine.projectId;
      let automationId = routine.automationId;
      const scheduleChanged =
        next.name !== routine.name ||
        next.cron !== routine.cron ||
        next.timezone !== routine.timezone;
      if (moved || !automationId) {
        // Automations belong to one project, so a move replaces the schedule.
        automationId = await replaceAutomation(bot, routine, next);
      } else {
        try {
          if (scheduleChanged) await deps.automations.update(bot, next);
          else await deps.automations.get(routine);
        } catch (error) {
          // Deleted outside Bots: saving schedules the routine again.
          if (!missing(error)) throw error;
          automationId = await replaceAutomation(bot, routine, next);
        }
      }
      // Reread so a run that started the conversation meanwhile is kept.
      const saved = save({
        ...latest(routineId),
        ...fields,
        automationId,
        // A moved routine starts a conversation in its new project.
        ...(moved ? { threadId: null } : {}),
        updatedAt: Date.now(),
      });
      deps.publish();
      return view(saved);
    });
  }

  async function act(routineId: string, action: RoutineAction) {
    return serial(`routine:${routineId}`, async () => {
      const routine = require(routineId);
      if (action === "delete") {
        if (routine.automationId)
          await deps.automations.delete(routine).catch((error) => {
            if (!missing(error)) throw error;
          });
        remove(routineId);
        deps.publish();
        return { routine: null, run: null };
      }
      if (!routine.automationId)
        throw new Error("This routine has no schedule. Save it to schedule it again.");
      let run: RoutineRun | null = null;
      if (action === "pause") await deps.automations.pause(routine);
      else if (action === "resume") await deps.automations.resume(routine);
      else run = toRun((await deps.automations.run(routine)).run);
      deps.publish();
      return { routine: await view(routine), run };
    });
  }

  const toRun = (run: z.infer<typeof automationRun>): RoutineRun => ({
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    error: run.error ?? run.skipReason,
    output: run.output,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });

  async function runs(routineId: string, limit: number) {
    const routine = require(routineId);
    if (!routine.automationId) return [];
    return (await deps.automations.runs(routine, limit)).runs.map(toRun);
  }

  /**
   * Delivers one run: the routine's instruction goes to its own subthread of
   * the bot's main chat, queued while that subthread is busy, and bb reports
   * each finished run to the main chat. The first run, or a run after the
   * subthread was archived, deleted, moved to another bot or left in another
   * project, starts a new one; a subthread left under an older main chat moves
   * under the current one. `automationId` is the calling automation's; a stale
   * schedule left behind by an earlier replacement is refused.
   */
  async function fire(routineId: string, automationId?: string) {
    return serial(`routine:${routineId}`, async () => {
      const routine = require(routineId);
      if (automationId && automationId !== routine.automationId)
        throw new Error(
          `Automation ${automationId} no longer schedules this routine. Delete that automation.`,
        );
      const bot = deps.requireBot(routine.botId);
      if (!(await deps.allowedProjectIds(bot)).includes(routine.projectId))
        throw new Error(
          `${bot.name} is no longer linked to this routine's project. Link it again or move the routine.`,
        );
      const text = files.read("bots/routine/run", {
        name: routine.name,
        routineId: routine.id,
        instruction: routine.instruction,
      });
      const parentThreadId = await deps.mainChatId(bot);
      if (routine.threadId) {
        const thread = await bb.sdk.threads.get({ threadId: routine.threadId }).catch(() => null);
        if (
          thread &&
          // A routine conversation made the main chat starts a subthread under itself.
          thread.id !== parentThreadId &&
          !thread.archivedAt &&
          !thread.deletedAt &&
          (await deps.runsIn(bot, routine.projectId, thread.projectId)) &&
          (await deps.resolveOwner(thread.id, false)) === bot.id
        ) {
          if (thread.parentThreadId !== parentThreadId)
            await bb.sdk.threads.update({ threadId: thread.id, parentThreadId });
          const result = await bb.sdk.threads.send({
            threadId: thread.id,
            mode: "queue-if-active",
            input: [{ type: "text", text, mentions: [] }],
          });
          deps.publish();
          return { routineId, threadId: thread.id, delivery: result.delivery };
        }
      }
      const threadId = await deps.startConversation({ bot, routine, text, parentThreadId });
      save({ ...require(routineId), threadId, updatedAt: Date.now() });
      deps.publish();
      return { routineId, threadId, delivery: "started" as const };
    });
  }

  return {
    get,
    require,
    list,
    all,
    view,
    listViews: async (botId: string) => Promise.all(list(botId).map(view)),
    create,
    update,
    act,
    runs,
    fire,
  };
}
export type Routines = ReturnType<typeof createRoutines>;
