import {
  ADOPT_ROLES,
  type AdoptInput,
  type AdoptOptions,
  type AdoptResult,
} from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { adoptionBlockers, adoptThread, readAdoptee } from "./commands/dispatch.ts";
import type { Blocker } from "./output.ts";
import type { Captain } from "./registry.ts";
import { isDispatchable, ROLE_SPECS } from "./roles.ts";
import { TasksError, type TasksProject } from "./tasks-client.ts";

/**
 * The sidebar's Adopt into Captain dialog. Reads what it picks from, then
 * adopts through `adoptThread`, the path `bb captain dispatch --thread` runs.
 */

/** How many open tasks each repo offers in the dialog. */
export const ADOPT_TASKS_PER_REPO = 100;

/** Why the menu leaves a thread out: it is a Captain, or already some Captain's crew. */
export function menuBlocker(deps: CommandDeps, threadId: string, parentId: string | null) {
  if (deps.registry.get(threadId) !== null) {
    return { reason: `${threadId} is a Captain`, fix: "pick a thread that is not a Captain" };
  }
  const parent = deps.registry.get(parentId);
  if (parent === null) return null;
  return {
    reason: `${threadId} is crew of the ${parent.name} Captain`,
    fix: `bb captain status --captain ${parent.threadId}`,
  };
}

export async function adoptOptions(deps: CommandDeps, threadId: string): Promise<AdoptOptions> {
  const thread = await readAdoptee(deps, threadId);
  const captains = deps.store.liveCaptains();
  let projects: TasksProject[] = [];
  let tasksError: string | null = null;
  try {
    projects = await deps.tasks.listProjects();
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    tasksError = error.message;
  }
  const byPrefix = new Map(projects.map((project) => [project.prefix, project]));
  const menu = menuBlocker(deps, thread.id, thread.parentThreadId ?? null);
  const rows = await Promise.all(
    captains.map(async (captain) => {
      const repos = captain.repos.map((repo) => ({
        key: repo.tasksProjectKey,
        name: byPrefix.get(repo.tasksProjectKey)?.name ?? repo.tasksProjectKey,
        bbProjectId: repo.bbProjectId,
      }));
      const lists = await Promise.all(
        captain.repos.map(async (repo) => {
          const project = byPrefix.get(repo.tasksProjectKey);
          if (project === undefined || tasksError !== null) return [];
          try {
            return await deps.tasks.listOpenTasks(project.id, ADOPT_TASKS_PER_REPO);
          } catch (error) {
            if (!(error instanceof TasksError)) throw error;
            tasksError = error.message;
            return [];
          }
        }),
      );
      const blockers: Blocker[] = [
        ...(menu === null ? [] : [menu]),
        ...adoptionBlockers(deps, captain, thread, { task: "<task>", role: "Implement" }),
      ];
      return {
        id: captain.threadId,
        name: captain.name,
        repos,
        tasks: lists.flat().map(({ key, title, status }) => ({ key, title, status })),
        blockers: dedupe(blockers),
      };
    }),
  );
  return {
    thread: { id: thread.id, title: thread.title ?? "", projectId: thread.projectId },
    captains: rows,
    roles: ADOPT_ROLES.filter(isDispatchable).map((role) => ({
      value: role,
      label: ROLE_SPECS[role].label,
    })),
    tasksError,
  };
}

/**
 * Adopt from the dialog. A new task is created only after the thread's own
 * checks pass, so a refused adoption leaves no task behind.
 */
export async function adoptFromMenu(deps: CommandDeps, input: AdoptInput): Promise<AdoptResult> {
  const captain = deps.registry.get(input.captainId);
  if (captain === null) {
    return {
      ok: false,
      blockers: [{ reason: `${input.captainId} is not a live Captain`, fix: "pick another" }],
    };
  }
  const thread = await readAdoptee(deps, input.threadId);
  const role = ROLE_SPECS[input.role].label;
  const menu = menuBlocker(deps, thread.id, thread.parentThreadId ?? null);
  const taskHint = input.task.kind === "existing" ? input.task.key : "<task>";
  const blockers = dedupe([
    ...(menu === null ? [] : [menu]),
    ...adoptionBlockers(deps, captain, thread, { task: taskHint, role }),
  ]);
  if (blockers.length > 0) return { ok: false, blockers };

  let key: string;
  let created = false;
  if (input.task.kind === "existing") {
    key = input.task.key;
  } else {
    const made = await createTask(
      deps,
      captain,
      input.task.projectKey,
      input.task.title,
      thread.id,
    );
    if ("blocker" in made) return { ok: false, blockers: [made.blocker] };
    key = made.key;
    created = true;
  }
  const adopted = await adoptThread(deps, captain, [key], [role], thread.id, {
    again: false,
    dryRun: false,
    baseBranch: undefined,
    rung: undefined,
  });
  if (!adopted.ok) return { ok: false, blockers: adopted.blockers };
  const { item } = adopted;
  return {
    ok: true,
    task: key,
    created,
    state: item.state,
    adopted: item.state === "adopted",
    detail: item.detail ?? "",
    blockers: item.blockers ?? [],
    warnings: adopted.notes,
  };
}

async function createTask(
  deps: CommandDeps,
  captain: Captain,
  projectKey: string,
  title: string,
  threadId: string,
): Promise<{ key: string } | { blocker: Blocker }> {
  if (!captain.repos.some((repo) => repo.tasksProjectKey === projectKey)) {
    return {
      blocker: {
        reason: `${projectKey} is not one of the ${captain.name} Captain's repos`,
        fix: "pick one of its repos",
      },
    };
  }
  try {
    const project = (await deps.tasks.listProjects()).find((each) => each.prefix === projectKey);
    if (project === undefined) {
      return { blocker: { reason: `Tasks has no ${projectKey} project`, fix: "bb tasks list" } };
    }
    const task = await deps.tasks.createTask({
      projectId: project.id,
      title,
      description: `Brought in from thread ${threadId} through the sidebar's Adopt into Captain.`,
      status: "todo",
    });
    return { key: task.key };
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    return { blocker: { reason: error.message, fix: "bb plugin list; check scott-tasks" } };
  }
}

function dedupe(blockers: readonly Blocker[]): Blocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => !seen.has(blocker.reason) && seen.add(blocker.reason));
}
