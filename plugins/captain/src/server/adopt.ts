import { LADDER_ROLES, type LadderRole } from "../contract/ladder.ts";
import type { AdoptInput, AdoptOptions, AdoptResult } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { adoptionBlockers, adoptThread, checkAdoption, readAdoptee } from "./commands/dispatch.ts";
import { crewOnTask, LIVE_STATUSES, readCrew, tasksBlocker, type CrewThread } from "./crew.ts";
import { Refusal, type Blocker } from "./output.ts";
import type { Captain } from "./registry.ts";
import { ROLE_SPECS } from "./roles.ts";
import { TasksError, type TasksProject, type TasksTask } from "./tasks-client.ts";

/**
 * The thread menu's Adopt into Captain dialog. Reads what it picks from, then
 * adopts through `adoptThread`, the path `bb captain dispatch --thread` runs.
 */

/** How many open tasks each repo offers in the dialog. */
export const ADOPT_TASKS_PER_REPO = 100;

/** The keys of the tasks Tasks has each thread attached live to. While Tasks does not answer, none. */
async function liveTasks(
  deps: CommandDeps,
  threadIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const live = new Map<string, Set<string>>();
  if (threadIds.length === 0) return live;
  try {
    for (const row of await deps.tasks.crewSnapshot(threadIds)) {
      if (!LIVE_STATUSES.has(row.liveStatus)) continue;
      const keys = live.get(row.threadId) ?? new Set();
      live.set(row.threadId, keys.add(row.task.key.toUpperCase()));
    }
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
  }
  return live;
}

/**
 * The Captain each thread is live crew of on a task, else null. Crew means a
 * role record, which dispatch and adopt write once the thread is attached, or
 * a live attachment to any task in Tasks under a Captain parent, however it
 * was made. A thread whose adopt stopped before the attach has neither, so
 * the dialog can finish it, as a `dispatch --thread` rerun does.
 */
export async function crewOf(
  deps: CommandDeps,
  threadIds: readonly string[],
): Promise<Record<string, string | null>> {
  const crew: Record<string, string | null> = {};
  const unrecorded: string[] = [];
  for (const id of new Set(threadIds)) {
    const captain = deps.registry.get(deps.store.crewRole(id)?.captainId ?? null);
    crew[id] = captain?.threadId ?? null;
    if (captain === null) unrecorded.push(id);
  }
  const attached = await liveTasks(deps, unrecorded);
  await Promise.all(
    [...attached.keys()].map(async (id) => {
      const parent = await deps.bb.sdk.threads
        .get({ threadId: id })
        .then((thread) => thread.parentThreadId ?? null)
        .catch(() => null);
      crew[id] = deps.registry.get(parent)?.threadId ?? null;
    }),
  );
  return crew;
}

/**
 * Why the menu leaves a thread out: it is a Captain, or its parent Captain's
 * live crew on a task. A thread live only on `retryOnto`'s task with no role
 * record is an adopt whose attach landed but reported failure, so a retry
 * onto that task finishes it.
 */
async function menuBlocker(
  deps: CommandDeps,
  threadId: string,
  parentId: string | null,
  retryOnto: () => Promise<string | null> = async () => null,
): Promise<Blocker | null> {
  if (deps.registry.get(threadId) !== null) {
    return { reason: `${threadId} is a Captain`, fix: "pick a thread that is not a Captain" };
  }
  const parent = deps.registry.get(parentId);
  if (parent === null) return null;
  if (deps.store.crewRole(threadId)?.captainId !== parent.threadId) {
    const live = (await liveTasks(deps, [threadId])).get(threadId);
    if (live === undefined) return null;
    const target = await retryOnto();
    if (target !== null && [...live].every((key) => key === target.toUpperCase())) return null;
  }
  return {
    reason: `${threadId} is already crew of the ${parent.name} Captain`,
    fix: "nothing to do; the Captain's status lists it",
  };
}

export async function adoptOptions(deps: CommandDeps, threadId: string): Promise<AdoptOptions> {
  const thread = await readAdoptee(deps, threadId);
  const menu = await menuBlocker(deps, thread.id, thread.parentThreadId ?? null);
  const errors: string[] = [];
  const tasksRead =
    <T>(fallback: T) =>
    (error: unknown): T => {
      if (!(error instanceof TasksError)) throw error;
      errors.push(error.message);
      return fallback;
    };
  const projects = await deps.tasks.listProjects().catch(tasksRead<TasksProject[]>([]));
  const byPrefix = new Map(projects.map((project) => [project.prefix, project]));
  const captains = await Promise.all(
    deps.store.liveCaptains().map(async (captain) => {
      const [lists, crew] = await Promise.all([
        Promise.all(
          captain.repos.map((repo) => {
            const project = byPrefix.get(repo.tasksProjectKey);
            if (project === undefined) return [];
            return deps.tasks
              .listOpenTasks(project.id, ADOPT_TASKS_PER_REPO)
              .catch(tasksRead<TasksTask[]>([]));
          }),
        ),
        readCrew(deps, captain.threadId).catch(tasksRead<CrewThread[]>([])),
      ]);
      const blockers = [
        ...(menu === null ? [] : [menu]),
        ...adoptionBlockers(deps, captain, thread, null),
      ];
      return {
        id: captain.threadId,
        name: captain.name,
        repos: captain.repos.map((repo) => ({
          key: repo.tasksProjectKey,
          name: byPrefix.get(repo.tasksProjectKey)?.name ?? repo.tasksProjectKey,
          bbProjectId: repo.bbProjectId,
        })),
        tasks: lists.flat().map(({ key, title, status }) => ({
          key,
          title,
          status,
          held: heldRoles(crew, key, thread.id),
        })),
        blockers: dedupe(blockers),
      };
    }),
  );
  return {
    thread: { id: thread.id, title: thread.title ?? "", projectId: thread.projectId },
    captains,
    roles: LADDER_ROLES.map((role) => ({ value: role, label: ROLE_SPECS[role].label })),
    tasksError: errors[0] ?? null,
  };
}

/** The roles live threads other than this one hold on the task. */
function heldRoles(crew: readonly CrewThread[], taskKey: string, threadId: string): LadderRole[] {
  const held = new Set(
    crewOnTask(crew, taskKey)
      .filter((member) => member.thread.id !== threadId)
      .map((member) => member.role),
  );
  return LADDER_ROLES.filter((role) => held.has(role));
}

/**
 * Adopt from the dialog. Every refusal check runs before anything is written,
 * a new task included, and adopts of one thread run one at a time, so a
 * refused or retried adopt leaves no extra task. A refusal throws `Refusal`.
 */
export async function adoptFromMenu(
  deps: CommandDeps,
  input: AdoptInput,
): Promise<Extract<AdoptResult, { ok: true }>> {
  const captain = deps.registry.get(input.captainId);
  if (captain === null) {
    throw new Refusal([
      { reason: `${input.captainId} is not a live Captain`, fix: "pick another Captain" },
    ]);
  }
  return await deps.taskGuard(`adopt:${input.threadId}`, async () => {
    const thread = await readAdoptee(deps, input.threadId);
    const { task } = input;
    const marked = memo(async () => {
      if (task.kind !== "new") throw new Error("only a new task has a marked task");
      return await markedTask(deps, captain, task.projectKey, task.title, thread.id);
    });
    const menu = await menuBlocker(deps, thread.id, thread.parentThreadId ?? null, async () =>
      task.kind === "existing" ? task.key : ((await marked()).earlier?.key ?? null),
    );
    if (menu !== null) throw new Refusal([menu]);
    const role = ROLE_SPECS[input.role].label;
    let key: string;
    let created = false;
    if (task.kind === "existing") {
      key = task.key;
    } else {
      const blockers = await checkAdoption(deps, captain, role, thread.id);
      if (blockers.length > 0) throw new Refusal(dedupe(blockers));
      ({ key, created } = await taskFromTitle(deps, await marked(), task.title, thread.id));
    }
    // One start per task at a time, with dispatch: a second adopt onto the
    // same task and role then sees the first one's thread and is refused.
    const { item, notes } = await deps.taskGuard(key.toUpperCase(), () =>
      adoptThread(deps, captain, [key], [role], thread.id, {
        again: false,
        dryRun: false,
        baseBranch: undefined,
        rung: undefined,
      }),
    );
    if (item.state === "exists") {
      throw new Refusal([
        {
          reason: `${key} already has a live ${role} thread, ${String(item.data?.["thread"])}`,
          fix: "pick another task or role",
        },
      ]);
    }
    if (item.state !== "adopted") {
      throw new Refusal([
        {
          reason: item.detail ?? `${thread.id} was not adopted`,
          fix: "press Adopt again; it continues where this one stopped",
        },
      ]);
    }
    return {
      ok: true,
      task: key,
      created,
      detail: item.detail ?? "",
      warnings: notes,
    };
  });
}

/** What a task made from a thread's title carries, so a retry finds it instead of making another. */
const adoptMarker = (threadId: string) => `captain-adopt:${threadId}`;

type Marked = { project: TasksProject; earlier: TasksTask | null };

/**
 * The project for "New task", and the task a failed attempt to adopt this
 * thread with this title left behind, when it is still open and no live thread
 * has it. A Tasks failure is a `Refusal`.
 */
async function markedTask(
  deps: CommandDeps,
  captain: Captain,
  projectKey: string,
  title: string,
  threadId: string,
): Promise<Marked> {
  if (!captain.repos.some((repo) => repo.tasksProjectKey === projectKey)) {
    throw new Refusal([
      {
        reason: `${projectKey} is not one of the ${captain.name} Captain's repos`,
        fix: "pick one of its repos",
      },
    ]);
  }
  return await tasksRefusal(async () => {
    const project = (await deps.tasks.listProjects()).find((each) => each.prefix === projectKey);
    if (project === undefined) {
      throw new Refusal([{ reason: `Tasks has no ${projectKey} project`, fix: "bb tasks list" }]);
    }
    const marked = await deps.tasks.listOpenTasks(
      project.id,
      RESUME_CANDIDATES,
      adoptMarker(threadId),
    );
    // This thread's own row counts only once its role is recorded: an attach
    // that landed but reported failure leaves a row and no record.
    const unrecorded = deps.store.crewRole(threadId) === null;
    for (const task of marked.filter((each) => each.title.trim() === title)) {
      const threads = await deps.tasks.taskThreads(task.id);
      const taken = threads.some(
        (row) => !(unrecorded && row.threadId === threadId) && LIVE_STATUSES.has(row.liveStatus),
      );
      if (!taken) return { project, earlier: task };
    }
    return { project, earlier: null };
  });
}

/** The task for "New task": the earlier attempt's, else a new one. `created` says which. */
async function taskFromTitle(
  deps: CommandDeps,
  { project, earlier }: Marked,
  title: string,
  threadId: string,
): Promise<{ key: string; created: boolean }> {
  if (earlier !== null) return { key: earlier.key, created: false };
  const task = await tasksRefusal(() =>
    deps.tasks.createTask({
      projectId: project.id,
      title,
      description: `Brought in from thread ${threadId} through Adopt into Captain.\n\n<!-- ${adoptMarker(threadId)} -->`,
      status: "todo",
    }),
  );
  return { key: task.key, created: true };
}

/** How many marked tasks a retry looks through for the one its failed attempt left. */
const RESUME_CANDIDATES = 10;

async function tasksRefusal<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TasksError) throw new Refusal([tasksBlocker(error)]);
    throw error;
  }
}

/** One run of `read`, however often it is called. */
function memo<T>(read: () => Promise<T>): () => Promise<T> {
  let once: Promise<T> | undefined;
  return () => (once ??= read());
}

function dedupe(blockers: readonly Blocker[]): Blocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => !seen.has(blocker.reason) && seen.add(blocker.reason));
}
