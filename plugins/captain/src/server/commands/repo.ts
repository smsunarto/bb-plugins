import { cliCommand } from "@get-bb/plugin-sdk";
import { actingFor } from "../caller.ts";
import { guard, Refusal, render } from "../output.ts";
import { applyLink, isBlocker, planTasksLink, resolveBbProject } from "../repos.ts";
import type { Repo } from "../store.ts";
import { TasksError } from "../tasks-client.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

const PROJECT = {
  name: "project",
  required: true,
  description: "A bb project id or name",
} as const;

export function repoAddCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Add a repo to the Captain, linking or creating its Tasks project",
    positionals: [PROJECT],
    options: {
      tasks: {
        type: "string",
        placeholder: "KEY",
        description:
          "The Tasks project key to link; an unlinked one is linked, a missing one is created (default: the linked one, else a new one)",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain repo add", json, async () => {
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
        });
        const resolved = resolveBbProject(
          input.positionals.project,
          await deps.bb.sdk.projects.list(),
        );
        if ("blocker" in resolved) throw new Refusal([resolved.blocker]);
        const { project } = resolved;
        const key = input.options.tasks?.trim().toUpperCase();
        const current = captain.repos.find((repo) => repo.bbProjectId === project.id);
        if (current !== undefined && (key === undefined || key === current.tasksProjectKey)) {
          return render([repoItem(current, "exists", project.name)], json);
        }
        const tasksProjects = await tasksCall(() => deps.tasks.listProjects());
        const plan = planTasksLink(
          project,
          tasksProjects,
          key,
          new Set(tasksProjects.map((entry) => entry.prefix)),
        );
        if (isBlocker(plan)) throw new Refusal([plan]);
        const { repo, note } = await tasksCall(() => applyLink(deps.tasks, project, plan));
        deps.store.putRepo(captain.threadId, repo);
        deps.registry.setRepos(captain.threadId, [
          ...captain.repos.filter((entry) => entry.bbProjectId !== project.id),
          repo,
        ]);
        return render([repoItem(repo, "added", project.name)], json, note === null ? [] : [note]);
      });
    },
  });
}

export function repoRemoveCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Remove a repo from the Captain; its tasks stay in Tasks",
    positionals: [{ ...PROJECT, description: "A bb project id or name, or its Tasks key" }],
    options: { captain: CAPTAIN_OPTION, json: JSON_OPTION },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain repo remove", json, async () => {
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
        });
        const address = input.positionals.project.trim();
        let repo = captain.repos.find(
          (entry) =>
            entry.bbProjectId === address || entry.tasksProjectKey === address.toUpperCase(),
        );
        if (repo === undefined) {
          const resolved = resolveBbProject(address, await deps.bb.sdk.projects.list());
          if ("project" in resolved) {
            repo = captain.repos.find((entry) => entry.bbProjectId === resolved.project.id);
          }
        }
        if (repo === undefined) {
          return render(
            [{ id: address, ok: true, state: "absent", detail: "not one of this Captain's repos" }],
            json,
          );
        }
        if (captain.repos.length === 1) {
          throw new Refusal([
            {
              reason: `${repo.tasksProjectKey} is this Captain's only repo`,
              fix: "bb captain repo add <project> first, or bb captain archive",
            },
          ]);
        }
        const removed = repo;
        deps.store.removeRepo(captain.threadId, removed.bbProjectId);
        deps.registry.setRepos(
          captain.threadId,
          captain.repos.filter((entry) => entry.bbProjectId !== removed.bbProjectId),
        );
        return render([repoItem(removed, "removed", null)], json);
      });
    },
  });
}

function repoItem(repo: Repo, state: string, name: string | null) {
  return {
    id: repo.tasksProjectKey,
    ok: true,
    state,
    detail: name === null ? repo.bbProjectId : `${repo.bbProjectId}  ${name}`,
    data: { bbProjectId: repo.bbProjectId, tasksProjectKey: repo.tasksProjectKey },
  };
}

async function tasksCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    throw new Refusal([
      { reason: error.message, fix: "bb plugin list; enable it with bb plugin enable scott-tasks" },
    ]);
  }
}
