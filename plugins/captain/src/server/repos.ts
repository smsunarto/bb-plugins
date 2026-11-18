import type { Blocker } from "./output.ts";
import type { Repo } from "./store.ts";
import { TASKS_PREFIX, type TasksClient, type TasksProject } from "./tasks-client.ts";

export type BbProject = { id: string; name: string };

/** Find a bb project by id, else by exact name (case-insensitive). */
export function resolveBbProject(
  address: string,
  projects: readonly BbProject[],
): { project: BbProject } | { blocker: Blocker } {
  const wanted = address.trim();
  const byId = projects.find((project) => project.id === wanted);
  if (byId !== undefined) return { project: byId };
  const named = projects.filter((project) => project.name.toLowerCase() === wanted.toLowerCase());
  const [only] = named;
  if (only !== undefined && named.length === 1) return { project: only };
  if (named.length > 1) {
    return {
      blocker: {
        reason: `${named.length} bb projects are named ${JSON.stringify(wanted)}`,
        fix: `pass the project id: ${named.map((project) => project.id).join(", ")}`,
      },
    };
  }
  return {
    blocker: { reason: `no bb project is ${JSON.stringify(wanted)}`, fix: "bb project list" },
  };
}

/** How a bb project gets its Tasks project: use the linked one, link an unlinked one, or create one. */
export type LinkPlan =
  | { kind: "use"; project: TasksProject }
  | { kind: "link"; project: TasksProject }
  | { kind: "create"; prefix: string };

/**
 * Plan the Tasks project for a repo. `used` holds the prefixes already taken,
 * including ones planned for other repos in the same call; a planned prefix is
 * added to it.
 */
export function planTasksLink(
  bbProject: BbProject,
  tasksProjects: readonly TasksProject[],
  key: string | undefined,
  used: Set<string>,
): LinkPlan | Blocker {
  if (key !== undefined) {
    const prefix = key.trim().toUpperCase();
    if (!TASKS_PREFIX.test(prefix)) {
      return {
        reason: `--tasks ${JSON.stringify(key)} is not a Tasks key`,
        fix: "pass uppercase letters and digits, starting with a letter, at most 10",
      };
    }
    const existing = tasksProjects.find((project) => project.prefix === prefix);
    if (existing === undefined) {
      if (used.has(prefix))
        return {
          reason: `${prefix} is planned twice`,
          fix: "pass a distinct --tasks key per repo",
        };
      used.add(prefix);
      return { kind: "create", prefix };
    }
    if (existing.linkedBbProjectId === bbProject.id) return { kind: "use", project: existing };
    if (existing.linkedBbProjectId === null) return { kind: "link", project: existing };
    return {
      reason: `Tasks project ${prefix} is linked to another bb project (${existing.linkedBbProjectId})`,
      fix: `pass another --tasks key, or relink it: bb tasks project update ${prefix} --link-bb-project ${bbProject.id}`,
    };
  }
  const linked = tasksProjects.filter((project) => project.linkedBbProjectId === bbProject.id);
  const [only] = linked;
  if (only !== undefined && linked.length === 1) return { kind: "use", project: only };
  if (linked.length > 1) {
    return {
      reason: `${linked.length} Tasks projects link to ${bbProject.name}: ${linked.map((p) => p.prefix).join(", ")}`,
      fix: `pass one with --tasks ${linked[0]?.prefix ?? "<key>"}`,
    };
  }
  const prefix = derivePrefix(bbProject.name, used);
  if (prefix === null) {
    return {
      reason: `no free Tasks key derives from ${JSON.stringify(bbProject.name)}`,
      fix: "pass --tasks <KEY>",
    };
  }
  used.add(prefix);
  return { kind: "create", prefix };
}

/** As `bb tasks project create` derives one: letters and digits, at most 10, numbered on collision. */
function derivePrefix(name: string, used: ReadonlySet<string>): string | null {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  if (!/^[A-Z]/u.test(base)) base = `P${base}`;
  base = base.slice(0, 10);
  if (!used.has(base)) return base;
  for (let number = 2; number < 10_000; number += 1) {
    const suffix = String(number);
    const candidate = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

/** Carry out a plan. Returns the repo and a note for stderr when Tasks changed. */
export async function applyLink(
  tasks: TasksClient,
  bbProject: BbProject,
  plan: LinkPlan,
): Promise<{ repo: Repo; note: string | null }> {
  const repo = (key: string): Repo => ({ bbProjectId: bbProject.id, tasksProjectKey: key });
  switch (plan.kind) {
    case "use":
      return { repo: repo(plan.project.prefix), note: null };
    case "link":
      await tasks.linkProject(plan.project.id, bbProject.id);
      return {
        repo: repo(plan.project.prefix),
        note: `linked Tasks project ${plan.project.prefix} to ${bbProject.name}`,
      };
    case "create": {
      const created = await tasks.createProject({
        name: bbProject.name,
        prefix: plan.prefix,
        linkedBbProjectId: bbProject.id,
      });
      return {
        repo: repo(created.prefix),
        note: `created Tasks project ${created.prefix} for ${bbProject.name}`,
      };
    }
  }
}

export function isBlocker(value: LinkPlan | Blocker): value is Blocker {
  return "reason" in value;
}
