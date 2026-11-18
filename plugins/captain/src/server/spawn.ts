import type { LadderRole, Rung } from "../contract/ladder.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { rungPresetName } from "./ladder.ts";
import { setPushLevel } from "./push.ts";
import type { Captain } from "./registry.ts";
import { ROLE_SPECS, type Role } from "./roles.ts";
import { crewOnTask, readCrew } from "./crew.ts";
import { TasksError, type TasksPreset } from "./tasks-client.ts";

/**
 * Starting one crew thread through Tasks, shared by `dispatch` and the
 * rate-limit fallback: the rung's preset brought to the rung's provider,
 * model and reasoning, the delegate, and the role row. Both callers hold the
 * task's guard, so two starts of one task never race.
 */

export type TaskGuard = ReturnType<typeof createTaskGuard>;

type SpawnDeps = Pick<CommandDeps, "bb" | "store" | "registry" | "tasks" | "files" | "now">;

/** Per-task guard: runs on one task wait for each other; different tasks run in parallel. */
export function createTaskGuard() {
  const guards = new Map<string, Promise<void>>();
  return async function withTaskGuard<T>(
    key: string,
    run: (waited: boolean) => Promise<T>,
  ): Promise<T> {
    const previous = guards.get(key);
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = (previous ?? Promise.resolve()).then(() => mine);
    guards.set(key, chained);
    if (previous !== undefined) await previous;
    try {
      return await run(previous !== undefined);
    } finally {
      release();
      if (guards.get(key) === chained) guards.delete(key);
    }
  };
}

/**
 * The rung's Tasks preset, created or pointed at the rung's execution. Rung 1
 * is the role's own preset; a later rung copies rung 1's other fields
 * (permission, environment, machine, instructions) so only the model differs.
 */
export async function ensureRungPreset(
  deps: Pick<CommandDeps, "tasks">,
  role: LadderRole,
  rung: number,
  spec: Rung,
  presets: readonly TasksPreset[],
): Promise<TasksPreset> {
  const name = rungPresetName(role, rung);
  const byName = (wanted: string) =>
    presets.find((preset) => preset.name.toLowerCase() === wanted.toLowerCase());
  const execution = {
    providerId: spec.providerId,
    modelId: spec.model,
    reasoningLevel: spec.reasoningLevel,
    serviceTier: spec.serviceTier ?? null,
  };
  const existing = byName(name);
  if (existing !== undefined) {
    const same =
      existing.providerId === execution.providerId &&
      existing.modelId === execution.modelId &&
      existing.reasoningLevel === execution.reasoningLevel &&
      (existing.serviceTier ?? null) === execution.serviceTier;
    return same ? existing : await deps.tasks.updatePresetExecution(existing.id, execution);
  }
  const spec1 = ROLE_SPECS[role].preset;
  if (spec1 === null) throw new Error(`${role} has no preset`);
  const template = byName(rungPresetName(role, 1));
  return await deps.tasks.createPreset({
    name,
    ...execution,
    permissionMode: template?.permissionMode ?? spec1.permissionMode,
    environmentKind: template?.environmentKind ?? spec1.environmentKind,
    baseBranch: template?.baseBranch ?? null,
    machineId: template?.machineId ?? null,
    ...(template?.instructions === undefined ? {} : { instructions: template.instructions }),
  });
}

/**
 * Delegate one crew thread and record its role row, rung and push level. When
 * Tasks misses its deadline, a new child of the Captain on the task that is
 * not in `known` is the thread it started. Throws `TasksError` otherwise.
 */
export async function spawnCrew(
  deps: SpawnDeps,
  captain: Captain,
  start: {
    taskId: string;
    taskKey: string;
    role: Role;
    preset: TasksPreset;
    rung: number | null;
    baseBranch: string | undefined;
    /** Crew thread ids before the spawn. */
    known: ReadonlySet<string>;
  },
): Promise<{ threadId: string; notes: string[] }> {
  // Read before the spawn: the new session's CREW.md holds at least these rules.
  const rulesInCrewMd = deps.store.latestRuleId(captain.threadId);
  deps.registry.setPending(captain.threadId, start.taskKey, start.role);
  try {
    let threadId: string;
    const notes: string[] = [];
    try {
      threadId = await deps.tasks.delegate({
        taskId: start.taskId,
        presetId: start.preset.id,
        parentThreadId: captain.threadId,
        parentNotifications: "stuck",
        reportContract: deps.files.read("report"),
        extraInstructions: roleContract(deps, start.role),
        ...(start.baseBranch === undefined ? {} : { baseBranch: start.baseBranch }),
      });
    } catch (error) {
      if (!(error instanceof TasksError) || !error.timedOut) throw error;
      const late = await findLateThread(deps, captain, start);
      if (late === null) {
        throw new TasksError(`${error.message}, and no new thread is on ${start.taskKey} yet`, {
          cause: error,
          timedOut: true,
        });
      }
      threadId = late;
      notes.push(`${start.taskKey}: Tasks did not answer in time; found its new thread ${late}`);
    }
    notes.push(...(await recordCrew(deps, captain, threadId, start, rulesInCrewMd)));
    return { threadId, notes };
  } finally {
    deps.registry.clearPending(captain.threadId, start.taskKey);
  }
}

/** After a deadline: a child of the Captain, new since `known`, attached to this task. */
async function findLateThread(
  deps: SpawnDeps,
  captain: Captain,
  start: { taskKey: string; role: Role; known: ReadonlySet<string> },
): Promise<string | null> {
  try {
    const crew = await readCrew(deps, captain.threadId);
    const fresh = crewOnTask(crew, start.taskKey).find(
      (member) =>
        !start.known.has(member.thread.id) && (member.role === null || member.role === start.role),
    );
    return fresh?.thread.id ?? null;
  } catch (error) {
    if (error instanceof TasksError) return null;
    throw error;
  }
}

/** The role row, rule mark and push level of a thread just started. */
async function recordCrew(
  deps: SpawnDeps,
  captain: Captain,
  threadId: string,
  start: { role: Role; rung: number | null; baseBranch: string | undefined },
  rulesInCrewMd: number,
): Promise<string[]> {
  deps.store.putCrewRole({
    threadId,
    captainId: captain.threadId,
    role: start.role,
    reportDueSince: deps.now(),
    contractSent: true,
    rung: start.rung,
    baseBranch: start.baseBranch ?? null,
  });
  deps.store.markRulesSeen(threadId, rulesInCrewMd);
  const warning = await setPushLevel(deps.bb, threadId);
  return warning === null ? [] : [`warning: ${warning}`];
}

/** The role's contract, carried into the first prompt whatever the session timing. */
export function roleContract(deps: Pick<CommandDeps, "files">, role: Role): string {
  const contract = ROLE_SPECS[role].contract;
  return contract === null ? "" : deps.files.read(contract);
}
