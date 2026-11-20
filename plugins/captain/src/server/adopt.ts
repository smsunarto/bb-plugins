import { LADDER_ROLES, type LadderRole } from "../contract/ladder.ts";
import type { AdoptInput, AdoptOptions, AdoptResult } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { adoptionBlockers, adoptThread, checkAdoption, readAdoptee } from "./commands/dispatch.ts";
import { crewOnTask, readCrew, tasksBlocker, type CrewThread } from "./crew.ts";
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

/**
 * The Captain a thread is crew of on a task: its role record, which dispatch
 * and adopt write only once the thread is attached. A thread whose adopt
 * stopped before the attach has none, so the dialog can finish it, as a
 * `dispatch --thread` rerun does.
 */
export function crewOf(deps: CommandDeps, threadId: string): Captain | null {
  return deps.registry.get(deps.store.crewRole(threadId)?.captainId ?? null);
}

/** Why the menu leaves a thread out: it is a Captain, or its parent Captain's crew on a task. */
function menuBlocker(deps: CommandDeps, threadId: string, parentId: string | null): Blocker | null {
  if (deps.registry.get(threadId) !== null) {
    return { reason: `${threadId} is a Captain`, fix: "pick a thread that is not a Captain" };
  }
  const captain = crewOf(deps, threadId);
  if (captain === null || captain.threadId !== parentId) return null;
  return {
    reason: `${threadId} is already crew of the ${captain.name} Captain`,
    fix: "nothing to do; the Captain's status lists it",
  };
}

export async function adoptOptions(deps: CommandDeps, threadId: string): Promise<AdoptOptions> {
  const thread = await readAdoptee(deps, threadId);
  const menu = menuBlocker(deps, thread.id, thread.parentThreadId ?? null);
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
    const menu = menuBlocker(deps, thread.id, thread.parentThreadId ?? null);
    if (menu !== null) throw new Refusal([menu]);
    const role = ROLE_SPECS[input.role].label;
    let key: string;
    if (input.task.kind === "existing") {
      key = input.task.key;
    } else {
      const blockers = await checkAdoption(deps, captain, role, thread.id);
      if (blockers.length > 0) throw new Refusal(dedupe(blockers));
      key = await taskFromTitle(deps, captain, input.task.projectKey, input.task.title, thread.id);
    }
    const { item, notes } = await adoptThread(deps, captain, [key], [role], thread.id, {
      again: false,
      dryRun: false,
      baseBranch: undefined,
      rung: undefined,
    });
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
      created: input.task.kind === "new",
      detail: item.detail ?? "",
      warnings: notes,
    };
  });
}

/** What a task made from a thread's title carries, so a retry finds it instead of making another. */
const adoptMarker = (threadId: string) => `captain-adopt:${threadId}`;

/** The open task an earlier adopt of this thread made in the repo, else a new one. */
async function taskFromTitle(
  deps: CommandDeps,
  captain: Captain,
  projectKey: string,
  title: string,
  threadId: string,
): Promise<string> {
  if (!captain.repos.some((repo) => repo.tasksProjectKey === projectKey)) {
    throw new Refusal([
      {
        reason: `${projectKey} is not one of the ${captain.name} Captain's repos`,
        fix: "pick one of its repos",
      },
    ]);
  }
  try {
    const project = (await deps.tasks.listProjects()).find((each) => each.prefix === projectKey);
    if (project === undefined) {
      throw new Refusal([{ reason: `Tasks has no ${projectKey} project`, fix: "bb tasks list" }]);
    }
    const marker = adoptMarker(threadId);
    const [earlier] = await deps.tasks.listOpenTasks(project.id, 1, marker);
    if (earlier !== undefined) return earlier.key;
    const task = await deps.tasks.createTask({
      projectId: project.id,
      title,
      description: `Brought in from thread ${threadId} through Adopt into Captain.\n\n<!-- ${marker} -->`,
      status: "todo",
    });
    return task.key;
  } catch (error) {
    if (error instanceof TasksError) throw new Refusal([tasksBlocker(error)]);
    throw error;
  }
}

function dedupe(blockers: readonly Blocker[]): Blocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => !seen.has(blocker.reason) && seen.add(blocker.reason));
}
