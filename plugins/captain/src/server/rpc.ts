import { LADDER_ROLES, type LadderRole } from "../contract/ladder.ts";
import {
  describeSchedule,
  type Routine,
  type RoutineFields,
  type RoutineView,
} from "../contract/routines.ts";
import {
  captainContract,
  crewOfTag,
  crewTag,
  driveTag,
  LADDERS_TAG,
  type RoutineDraft,
  type SaveRoutineResult,
} from "../contract/rpc.ts";
import { adoptFromMenu, adoptOptions, crewOf } from "./adopt.ts";
import { resolveAsk } from "./asks.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { listChildren } from "./crew.ts";
import { DEFAULT_LADDERS, roleLadder } from "./ladder.ts";
import { ROLE_SPECS } from "./roles.ts";
import { Refusal } from "./output.ts";
import { startCaptain } from "./commands/new.ts";
import { captainIcons, setCaptainIcon } from "./icon.ts";
import {
  captainTasks,
  createPrimaryHost,
  openTasksSignature,
  driveFiles,
  driveSignature,
  watchDrive,
} from "./overview.ts";
import {
  askItems,
  createCrewReads,
  crewItems,
  deferItem,
  markSeen,
  needsYouCount,
  sinceYouLeft,
} from "./queue.ts";

/** How often a watched banner rechecks the crew for a new or answered interaction. */
export const CREW_POLL_MS = 10_000;
/** How often a watched Overview rechecks Tasks for a change made outside the crew. */
export const TASKS_POLL_MS = 30_000;
/**
 * How long the Routines list waits on Automations for one row's live schedule.
 * The rows come from `data.db`; past this a row shows Schedule unavailable.
 */
export const ROUTINE_SCHEDULE_WAIT_MS = 1_500;
/** Runs an opened routine shows. */
const ROUTINE_RUNS_SHOWN = 5;

/**
 * The banner's RPCs. Logic lives in `queue.ts` and `asks.ts`, shared with the
 * CLI; this file maps it onto the contract and keeps the reads fresh.
 */
export function registerRpc(
  deps: CommandDeps,
  crewPollMs: number = CREW_POLL_MS,
  driveScanMs?: number,
  tasksPollMs: number = TASKS_POLL_MS,
): void {
  const { bb } = deps;
  const live = (captainId: string) => {
    if (deps.registry.get(captainId) === null)
      throw new Error(`${captainId} is not a live Captain`);
  };
  const crewReads = createCrewReads(deps);
  const readCrew = (captainId: string) => crewReads.read(captainId);
  const primaryHost = createPrimaryHost(deps);
  const ladderOf = (role: LadderRole) => ({
    role,
    label: ROLE_SPECS[role].label,
    ...roleLadder(deps.store, role),
    defaults: [...DEFAULT_LADDERS[role]],
  });
  const routines = routineHandlers(deps, live);
  bb.rpc.register(captainContract, {
    ...routines,
    ladders: () => ({ roles: LADDER_ROLES.map(ladderOf) }),
    setLadder: ({ role, rungs }) => {
      deps.store.setLadderJson(role, rungs === null ? null : JSON.stringify(rungs), deps.now());
      bb.rpc.experimental_invalidate([LADDERS_TAG]);
      return ladderOf(role);
    },
    captains: () => ({ ids: deps.store.liveCaptains().map((captain) => captain.threadId) }),
    asks: ({ captainId }) => ({ items: askItems(deps, captainId) }),
    crew: async ({ captainId }) => {
      live(captainId);
      return { items: await crewItems(deps, captainId, readCrew) };
    },
    tasks: ({ captainId }) => {
      live(captainId);
      return captainTasks(deps, readCrew, captainId);
    },
    drive: ({ captainId }) => {
      live(captainId);
      return driveFiles(deps, primaryHost, captainId);
    },
    sinceYouLeft: ({ captainId }) => {
      live(captainId);
      return sinceYouLeft(deps, captainId);
    },
    resolveAsk: async ({ askId, answer }) => {
      try {
        const { state, notes } = await resolveAsk(deps, askId, answer);
        return { state, warnings: notes };
      } catch (error) {
        if (error instanceof Refusal) throw new Error(error.message, { cause: error });
        throw error;
      }
    },
    defer: ({ captainId, key, action }) => {
      live(captainId);
      return deferItem(deps, captainId, key, action);
    },
    markSeen: ({ captainId, client }) => {
      live(captainId);
      return markSeen(deps, captainId, client);
    },
    needsYou: async ({ keys }) => {
      const ids = [...new Set(keys)];
      const counts = await Promise.all(ids.map((id) => needsYouCount(deps, id)));
      return Object.fromEntries(ids.map((id, index) => [id, counts[index] ?? 0]));
    },
    crewOf: ({ keys }) => crewOf(deps, keys),
    adoptOptions: ({ threadId }) => adoptOptions(deps, threadId),
    adopt: async (input) => {
      try {
        const result = await adoptFromMenu(deps, input);
        crewReads.changed(input.captainId);
        bb.rpc.experimental_invalidate([crewTag(input.captainId), crewOfTag(input.threadId)]);
        return result;
      } catch (error) {
        if (error instanceof Refusal) return { ok: false as const, blockers: error.blockers };
        throw error;
      }
    },
    newCaptain: async ({ name, repos }) => {
      try {
        const started = await startCaptain(deps, { name, repos });
        if (!started.ok) return started;
        const { threadId, state, warnings } = started.captain;
        return { ok: true as const, threadId, state, warnings };
      } catch (error) {
        if (error instanceof Refusal) return { ok: false as const, blockers: error.blockers };
        throw error;
      }
    },
    icons: ({ keys }) => captainIcons(deps, keys),
    captainIcons: () => ({
      captains: deps.store.liveCaptains().map((captain) => ({
        threadId: captain.threadId,
        name: captain.name,
        icon: deps.store.captainIcon(captain.threadId),
      })),
    }),
    // An image refusal's message names why, such as its size; settings shows it as is.
    setIcon: ({ captainId, icon }) => setCaptainIcon(deps, captainId, icon),
  });

  const captainOf = (read: object) => captainOfRead(deps.registry, read);
  registerCrewWatch(
    deps,
    captainOf,
    createCrewWatch(deps, crewPollMs, crewReads.changed),
    (captainId, signal) => watchTasks(deps, captainId, signal, tasksPollMs, crewReads.changed),
  );
  registerDriveScan(deps, captainOf, driveScanMs);

  registerEvents(deps, crewReads.changed);
}

/**
 * A watched banner or Overview: bb's thread events cover run states; a new or
 * answered interaction has no event, so the crew list is rechecked while
 * watched. Both reads share one loop per Captain. The Overview's tasks also
 * recheck Tasks, for a change made outside the crew.
 */
function registerCrewWatch(
  deps: CommandDeps,
  captainOf: (read: object) => string | null,
  crewWatch: (captainId: string, signal: AbortSignal) => Promise<void>,
  tasksWatch: (captainId: string, signal: AbortSignal) => Promise<void>,
): void {
  for (const method of ["crew", "tasks"] as const) {
    deps.bb.rpc.experimental_whileWatched(method, async (read, signal) => {
      const captainId = captainOf(read);
      if (captainId === null) return;
      if (method === "crew") return crewWatch(captainId, signal);
      await Promise.all([crewWatch(captainId, signal), tasksWatch(captainId, signal)]);
    });
  }
}

/**
 * While a Captain's tasks read is watched, compare its open tasks every
 * `pollMs` and refresh the crew tag when they changed. A check that starts
 * or stops failing refreshes it too: the read then labels its rows as not
 * refreshed, and later replaces them, even when nothing else changed.
 */
async function watchTasks(
  deps: CommandDeps,
  captainId: string,
  signal: AbortSignal,
  pollMs: number,
  changed: (captainId: string) => void,
): Promise<void> {
  // The first check's outcome is the baseline: the read just ran against the same Tasks.
  let last: { ok: true; signature: string } | { ok: false } | null = null;
  while (!signal.aborted) {
    const now = await openTasksSignature(deps, captainId).then(
      (signature) => ({ ok: true as const, signature }),
      () => ({ ok: false as const }),
    );
    if (signal.aborted) return;
    if (last !== null && tasksMoved(last, now)) {
      changed(captainId);
      deps.bb.rpc.experimental_invalidate([crewTag(captainId)]);
    }
    last = now;
    await sleep(pollMs, signal);
  }
}

function tasksMoved(
  last: { ok: true; signature: string } | { ok: false },
  now: { ok: true; signature: string } | { ok: false },
): boolean {
  if (last.ok !== now.ok) return true;
  return last.ok && now.ok && last.signature !== now.signature;
}

/** While a `drive` read is watched, scan its Drive and refresh it when it changed. */
function registerDriveScan(
  deps: CommandDeps,
  captainOf: (read: object) => string | null,
  driveScanMs: number | undefined,
): void {
  const { bb } = deps;
  bb.rpc.experimental_whileWatched("drive", (read, signal) => {
    const captainId = captainOf(read);
    if (captainId === null) return Promise.resolve();
    return watchDrive({
      scan: () => driveSignature(deps, captainId),
      baseline: () => deps.registry.driveBaseline(captainId),
      setBaseline: (signature) => deps.registry.setDriveBaseline(captainId, signature),
      signal,
      onChange: () => bb.rpc.experimental_invalidate([driveTag(captainId)]),
      ...(driveScanMs === undefined ? {} : { scanMs: driveScanMs }),
    });
  });
}

/** The live Captain a watched read names, or null. */
function captainOfRead(registry: CommandDeps["registry"], read: object): string | null {
  if (!("input" in read)) return null;
  const captainId = (read.input as { captainId?: unknown } | null)?.captainId;
  return typeof captainId === "string" && registry.get(captainId) !== null ? captainId : null;
}

/**
 * One crew poll per Captain however many of its reads are watched: the first
 * watcher starts it, the last one to leave stops it. Resolves for each
 * watcher when its own `signal` aborts.
 */
function createCrewWatch(
  deps: CommandDeps,
  crewPollMs: number,
  changed: (captainId: string) => void,
) {
  const { bb } = deps;
  const loops = new Map<string, { watchers: number; stop: AbortController }>();

  async function poll(captainId: string, signal: AbortSignal): Promise<void> {
    let last: string | null = null;
    while (!signal.aborted) {
      try {
        const threads = await listChildren(bb, captainId, false, signal);
        const shape = threads
          .map((thread) => `${thread.id}:${thread.status}:${thread.hasPendingInteraction}`)
          .join(",");
        if (last !== null && shape !== last) {
          changed(captainId);
          bb.rpc.experimental_invalidate([crewTag(captainId)]);
        }
        last = shape;
      } catch (error) {
        if (signal.aborted) return;
        bb.log.warn(`crew watch for ${captainId}: ${(error as Error).message}`);
      }
      await sleep(crewPollMs, signal);
    }
  }

  return (captainId: string, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      let loop = loops.get(captainId);
      if (loop === undefined) {
        loop = { watchers: 0, stop: new AbortController() };
        loops.set(captainId, loop);
        void poll(captainId, loop.stop.signal);
      }
      loop.watchers += 1;
      const own = loop;
      signal.addEventListener(
        "abort",
        () => {
          own.watchers -= 1;
          if (own.watchers === 0) {
            own.stop.abort();
            if (loops.get(captainId) === own) loops.delete(captainId);
          }
          resolve();
        },
        { once: true },
      );
    });
}

/**
 * Refresh a Captain's crew read when it or one of its children changes run
 * state, or a child starts waiting on an interaction. A thread's crew record
 * is written as it is attached, before its run state or parent next changes,
 * so the same events refresh its row in the thread menus.
 */
function registerEvents(deps: CommandDeps, changed: (captainId: string) => void): void {
  const { bb } = deps;
  const captainOf = (thread: { id: string; parentThreadId: string | null }) =>
    deps.registry.get(thread.id) ?? deps.registry.get(thread.parentThreadId);
  const refresh = ({ thread }: { thread: { id: string; parentThreadId: string | null } }) => {
    const captain = captainOf(thread);
    if (captain !== null) changed(captain.threadId);
    bb.rpc.experimental_invalidate(
      captain === null ? [crewOfTag(thread.id)] : [crewTag(captain.threadId), crewOfTag(thread.id)],
    );
  };
  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
    "experimental_thread.parentChanged",
    "interaction.pending",
  ] as const) {
    bb.events.on(event, refresh);
  }
}

/**
 * The Overview's Routines RPCs over the routine service the CLI uses. Every
 * call names its Captain and is refused for a routine of another one.
 */
function routineHandlers(deps: CommandDeps, live: (captainId: string) => void) {
  const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const owned = (captainId: string, routineId: string): Routine => {
    live(captainId);
    const routine = deps.store.routine(routineId);
    if (routine === null || routine.captainId !== captainId)
      throw new Error(`${captainId} has no routine ${routineId}`);
    return routine;
  };
  /** The row from `data.db` alone, for when Automations does not answer in time. */
  const unscheduled = (routine: Routine): RoutineView => ({
    ...routine,
    when: describeSchedule(routine.schedule, "at" in routine.schedule ? serverTimezone : undefined),
    automation: null,
    automationError: "Schedule unavailable: bb Automations did not answer in time",
    done: false,
    missed: false,
    lastRun: deps.store.routineRuns(routine.id, 1)[0] ?? null,
  });
  const bounded = async (routine: Routine): Promise<RoutineView> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<RoutineView>((resolve) => {
      timer = setTimeout(() => resolve(unscheduled(routine)), ROUTINE_SCHEDULE_WAIT_MS);
    });
    try {
      return await Promise.race([deps.routines.view(routine), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const refused = (error: unknown): SaveRoutineResult => {
    if (error instanceof Refusal) return { ok: false, blockers: error.blockers };
    throw error;
  };
  return {
    routines: async ({ captainId }: { captainId: string }) => {
      live(captainId);
      const rows = deps.store.routinesOf(captainId);
      return { routines: await Promise.all(rows.map(bounded)), serverTimezone };
    },
    routineRuns: ({
      captainId,
      routineId,
      limit,
    }: {
      captainId: string;
      routineId: string;
      limit?: number | undefined;
    }) => {
      const routine = owned(captainId, routineId);
      return { runs: deps.store.routineRuns(routine.id, limit ?? ROUTINE_RUNS_SHOWN) };
    },
    routineAction: async ({
      captainId,
      routineId,
      action,
    }: {
      captainId: string;
      routineId: string;
      action: "pause" | "resume" | "run" | "delete";
    }) => {
      const routine = owned(captainId, routineId);
      try {
        return { runId: (await deps.routines.act(routine, action)).runId };
      } catch (error) {
        if (error instanceof Refusal) throw new Error(error.message, { cause: error });
        throw error;
      }
    },
    saveRoutine: async ({
      captainId,
      routineId,
      routine: draft,
    }: {
      captainId: string;
      routineId?: string | undefined;
      routine: RoutineDraft;
    }): Promise<SaveRoutineResult> => {
      try {
        if (routineId === undefined) {
          live(captainId);
          const row = deps.store.captain(captainId);
          if (row === null) throw new Error(`${captainId} is not a live Captain`);
          const owner = {
            threadId: row.threadId,
            name: row.name,
            homeProjectId: row.homeProjectId,
          };
          return { ok: true, routine: await deps.routines.create(owner, draft) };
        }
        const before = owned(captainId, routineId);
        return { ok: true, routine: await deps.routines.update(before, changes(before, draft)) };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

/**
 * The fields a form save changes. `update` treats any schedule it is given as
 * new, so an unchanged one is left out: a one-shot that already ran stays
 * editable by name or instruction.
 */
function changes(before: Routine, draft: RoutineDraft): Partial<RoutineFields> {
  const words = (text: string) => text.trim().split(/\s+/u).join(" ");
  const sameSchedule =
    "at" in draft.schedule
      ? "at" in before.schedule && before.schedule.at === draft.schedule.at
      : "cron" in before.schedule &&
        words(draft.schedule.cron) === before.schedule.cron &&
        draft.schedule.timezone.trim() === before.schedule.timezone;
  return {
    ...(draft.name.trim() === before.name ? {} : { name: draft.name }),
    ...(draft.instruction.trim() === before.instruction ? {} : { instruction: draft.instruction }),
    ...(sameSchedule ? {} : { schedule: draft.schedule as RoutineFields["schedule"] }),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
