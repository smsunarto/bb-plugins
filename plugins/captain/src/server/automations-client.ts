import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Routine, Schedule } from "../contract/routines.ts";

/** bb's built-in Automations plugin: it holds each routine's schedule and run history. */
export const AUTOMATIONS_PLUGIN_ID = "automations";
const DEADLINE_MS = 8_000;
const NAME_MAX = 200;
/** The script's env var naming its routine; reconcile finds Captain's automations by it. */
export const ROUTINE_ENV = "BB_CAPTAIN_ROUTINE_ID";

/**
 * The stored script each routine's automation runs on the bb server. It hands
 * the run to Captain, which owns the guards and the message. Automations sets
 * `BB_SERVER_URL`, `BB_AUTOMATION_ID` and `BB_AUTOMATION_RUN_ID`, and `BB_CLI`
 * when it found the bb binary.
 */
export const ROUTINE_SCRIPT = [
  `exec "\${BB_CLI:-bb}" captain routine fire "$${ROUTINE_ENV}" --automation "\${BB_AUTOMATION_ID:-}" --run "\${BB_AUTOMATION_RUN_ID:-}"`,
  "",
].join("\n");

const statusSchema = z.looseObject({
  id: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastRunStatus: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type AutomationStatus = z.infer<typeof statusSchema>;

const runSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  trigger: z.string(),
  startedAt: z.number(),
});

const detailSchema = z.looseObject({
  id: z.string(),
  execution: z
    .looseObject({
      mode: z.string(),
      script: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

/** A list row; rows Automations cannot read carry `problem` and are skipped. */
const listRowSchema = z.looseObject({
  id: z.string(),
  problem: z.string().optional(),
  execution: z.looseObject({ env: z.record(z.string(), z.string()).optional() }).optional(),
});

/** The one place a "no such automation" error is recognised. */
export function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no automation|does not exist/iu.test(message);
}

function trigger(schedule: Schedule) {
  return "at" in schedule
    ? { triggerType: "once" as const, runAt: schedule.at }
    : { triggerType: "schedule" as const, cron: schedule.cron, timezone: schedule.timezone };
}

/** Where a routine's automation lives: the Captain's home project. */
export type AutomationTarget = { projectId: string; automationId: string };

/** The Automations RPCs a routine needs; tests replace the plugin behind `callRpc`. */
export function createAutomationsClient(bb: Pick<BbPluginApi, "sdk">) {
  const call = <T>(method: string, input: unknown, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({
      pluginId: AUTOMATIONS_PLUGIN_ID,
      method,
      input: input as never,
      outputSchema,
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  const name = (captainName: string, routine: Pick<Routine, "name">) =>
    `Captain ${captainName} · ${routine.name}`.slice(0, NAME_MAX);
  return {
    create: (
      projectId: string,
      captainName: string,
      routine: Pick<Routine, "id" | "name" | "schedule">,
      enabled: boolean,
    ) =>
      call(
        "automations_create",
        {
          projectId,
          name: name(captainName, routine),
          enabled,
          trigger: trigger(routine.schedule),
          execution: {
            mode: "script",
            script: ROUTINE_SCRIPT,
            interpreter: "sh",
            timeoutMs: 60_000,
            env: { [ROUTINE_ENV]: routine.id },
            workingDirectory: { type: "automation-storage" },
          },
          origin: "app",
        },
        statusSchema,
      ),
    /** Send only what changed: Automations validates every trigger it is given, so a spent one-shot's would be refused. */
    update: (
      target: AutomationTarget,
      captainName: string,
      changes: { name?: string; schedule?: Schedule },
    ) =>
      call(
        "automations_update",
        {
          ...target,
          ...(changes.name === undefined
            ? {}
            : { name: name(captainName, { name: changes.name }) }),
          ...(changes.schedule === undefined ? {} : { trigger: trigger(changes.schedule) }),
        },
        statusSchema,
      ),
    /**
     * Whether this automation is Captain's for the routine: a script
     * automation running exactly `ROUTINE_SCRIPT` with only the routine's id
     * in its env. Cleanup deletes nothing else.
     */
    async ownedBy(target: AutomationTarget, routineId: string): Promise<boolean> {
      const detail = await call("automations_get", target, detailSchema);
      const env = detail.execution?.env ?? {};
      return (
        detail.execution?.mode === "script" &&
        detail.execution.script?.trim() === ROUTINE_SCRIPT.trim() &&
        Object.keys(env).length === 1 &&
        env[ROUTINE_ENV] === routineId
      );
    },
    get: (target: AutomationTarget) => call("automations_get", target, statusSchema),
    pause: (target: AutomationTarget) => call("automations_pause", target, statusSchema),
    resume: (target: AutomationTarget) => call("automations_resume", target, statusSchema),
    run: (target: AutomationTarget) =>
      call("automations_run", target, z.looseObject({ run: runSchema })),
    delete: (target: AutomationTarget) =>
      call("automations_delete", target, z.looseObject({ ok: z.literal(true) })),
    /** Captain's automations in a project: script rows that name a routine. */
    async listRoutineAutomations(
      projectId: string,
    ): Promise<{ automationId: string; routineId: string }[]> {
      const rows = await call("automations_list", { projectId }, z.array(listRowSchema));
      return rows.flatMap((row) => {
        const routineId = row.execution?.env?.[ROUTINE_ENV];
        return row.problem === undefined && routineId !== undefined
          ? [{ automationId: row.id, routineId }]
          : [];
      });
    },
  };
}
export type AutomationsClient = ReturnType<typeof createAutomationsClient>;
