import { cliCommand } from "@get-bb/plugin-sdk";
import { crewTag } from "../../contract/rpc.ts";
import { actingFor, readCallerFile } from "../caller.ts";
import { resolveTask, tasksBlocker, tasksOrRefuse } from "../crew.ts";
import { guard, refuse, Refusal, render, type Blocker, type Item } from "../output.ts";
import type { Captain } from "../registry.ts";
import { TasksError, type TasksTask } from "../tasks-client.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

/** Statuses a new task may start in; dispatch moves it on from either. */
const START_STATUSES = ["backlog", "todo"] as const;
/** Tasks' priorities, as `bb tasks create` takes them. */
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

/** A task title on one line of text output, so it cannot add lines shaped like result rows. */
export function oneLine(text: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what this strips
  return text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

/**
 * `bb captain create`: create a task in one of the Captain's repos and record
 * the Captain as its owner, so the Overview lists it before any crew is
 * dispatched. Tasks records no creator, so a task made with raw
 * `bb tasks create` belongs to no Captain until one dispatches or claims it.
 */
export function createCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Create a task owned by this Captain; prints the new key",
    unexpectedPositionalHint: "the task title belongs in --title <title>.",
    options: {
      project: {
        type: "string",
        required: true,
        placeholder: "KEY",
        description: "The Tasks project key of one of the Captain's repos, such as BBP",
      },
      title: { type: "string", required: true, description: "Task title" },
      "description-file": {
        type: "string",
        placeholder: "path",
        description: "Read the description, the brief, from this UTF-8 file on the calling machine",
      },
      description: {
        type: "string",
        placeholder: "markdown",
        description: "The description inline; use --description-file for a brief",
      },
      priority: {
        type: "enum",
        values: PRIORITIES,
        default: "none",
        description: "Task priority",
      },
      status: {
        type: "enum",
        values: START_STATUSES,
        default: "backlog",
        description: "The status it starts in",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    constraints: [{ kind: "at-most-one", options: ["description", "description-file"] }],
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain create", json, async () => {
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
          action: "create tasks",
        });
        const title = input.options.title.trim();
        const prefix = input.options.project.trim().toUpperCase();
        const blockers: Blocker[] = [];
        if (title === "")
          blockers.push({ reason: "the title is empty", fix: 'pass --title "<title>"' });
        const repoBlocker = outsideRepos(captain, prefix);
        if (repoBlocker !== null) blockers.push(repoBlocker);
        if (blockers.length > 0) return refuse("captain create", blockers, json);
        const path = input.options["description-file"];
        const description =
          path === undefined
            ? (input.options.description ?? "")
            : await readCallerFile(deps.bb, ctx, path);
        const project = (await tasksOrRefuse(() => deps.tasks.listProjects())).find(
          (entry) => entry.prefix.toUpperCase() === prefix,
        );
        if (project === undefined) {
          return refuse(
            "captain create",
            [
              {
                reason: `Tasks has no project ${prefix}`,
                fix: `bb captain repo add <project> --tasks ${prefix}`,
              },
            ],
            json,
          );
        }
        const task = await createOrRefuse(deps, {
          projectId: project.id,
          title,
          description,
          status: input.options.status,
          priority: input.options.priority,
        });
        deps.store.recordTaskOwner({
          captainId: captain.threadId,
          taskId: task.id,
          taskKey: task.key,
          source: "created",
          at: deps.now(),
        });
        deps.bb.rpc.experimental_invalidate([crewTag(captain.threadId)]);
        return render(
          [
            {
              id: task.key,
              ok: true,
              state: "created",
              detail: oneLine(task.title),
              data: { taskId: task.id, status: task.status, captain: captain.threadId },
            },
          ],
          json,
        );
      });
    },
  });
}

/** The repo blocker `resolveTask` gives a key outside the Captain's repos, for a project prefix. */
function outsideRepos(captain: Captain, prefix: string): Blocker | null {
  const keys = captain.repos.map((repo) => repo.tasksProjectKey);
  if (keys.includes(prefix)) return null;
  return {
    reason: `${prefix} is not in this Captain's repos (${keys.join(", ")})`,
    fix: `bb captain repo add <project> --tasks ${prefix}`,
  };
}

/**
 * Create the task. A deadline that fires may still have created it, so that
 * refusal says to look for it before a rerun makes a second one.
 */
async function createOrRefuse(
  deps: CommandDeps,
  input: Parameters<CommandDeps["tasks"]["createTask"]>[0],
): Promise<TasksTask> {
  try {
    return await deps.tasks.createTask(input);
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    if (!error.timedOut) throw new Refusal([tasksBlocker(error)]);
    throw new Refusal([
      {
        reason: `${error.message}; Tasks may still have created the task`,
        fix: `look for it first with bb tasks list --search ${JSON.stringify(input.title)}; if it is there, bb captain claim <key> instead of rerunning`,
      },
    ]);
  }
}

/** Task keys as given, upper-cased and deduplicated in order. */
function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim().toUpperCase()))];
}

/** Resolve every key in the Captain's repos, or refuse naming each bad one. */
async function resolveAll(
  deps: CommandDeps,
  captain: Captain,
  keys: readonly string[],
): Promise<TasksTask[]> {
  const resolved = await tasksOrRefuse(() =>
    Promise.all(uniqueKeys(keys).map((key) => resolveTask(deps, captain, key))),
  );
  const blockers = resolved.flatMap((entry) => ("blocker" in entry ? [entry.blocker] : []));
  if (blockers.length > 0) throw new Refusal(blockers);
  return resolved.flatMap((entry) => ("task" in entry ? [entry.task] : []));
}

const TASK_POSITIONAL = {
  name: "task",
  required: true,
  variadic: true,
  description: "Task keys, such as PLUG-14; case-insensitive",
} as const;

/**
 * `bb captain claim`: record the calling Captain as the owner of tasks that
 * already exist, such as one made with raw `bb tasks create` or one the
 * backfill could not place. Claiming changes nothing in Tasks.
 */
export function claimCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Make existing tasks this Captain's, so its Overview lists them",
    positionals: [TASK_POSITIONAL],
    options: { captain: CAPTAIN_OPTION, json: JSON_OPTION },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain claim", json, async () => {
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
          action: "claim tasks",
        });
        const tasks = await resolveAll(deps, captain, input.positionals.task);
        const items: Item[] = tasks.map((task) => {
          deps.store.recordTaskOwner({
            captainId: captain.threadId,
            taskId: task.id,
            taskKey: task.key,
            source: "claimed",
            at: deps.now(),
          });
          return { id: task.key, ok: true, state: "claimed", detail: oneLine(task.title) };
        });
        deps.bb.rpc.experimental_invalidate([crewTag(captain.threadId)]);
        return render(items, json);
      });
    },
  });
}

/**
 * `bb captain release`: drop this Captain's ownership of tasks, such as a
 * mistaken claim. The task leaves this Captain's Overview; Tasks and any crew
 * on it are unchanged, and another Captain's ownership stays.
 */
export function releaseCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Drop tasks from this Captain's ownership, so its Overview stops listing them",
    positionals: [TASK_POSITIONAL],
    options: { captain: CAPTAIN_OPTION, json: JSON_OPTION },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain release", json, async () => {
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
          action: "release tasks",
        });
        const tasks = await resolveAll(deps, captain, input.positionals.task);
        const items: Item[] = tasks.map((task) => {
          const released = deps.store.releaseTaskOwner(captain.threadId, task.id);
          return {
            id: task.key,
            ok: true,
            state: released ? "released" : "not owned",
            detail: oneLine(task.title),
          };
        });
        deps.bb.rpc.experimental_invalidate([crewTag(captain.threadId)]);
        return render(items, json);
      });
    },
  });
}
