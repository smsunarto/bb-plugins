import { cliCommand } from "@get-bb/plugin-sdk";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CAPTAIN_NAME_MAX, CAPTAINS_TAG } from "../../contract/rpc.ts";
import { markPersonFacing } from "../audience.ts";
import { readCallerFile, refuseCrew } from "../caller.ts";
import { DRIVE_FILES } from "../drive.ts";
import { guard, refuse, Refusal, render, type Blocker, type Item } from "../output.ts";
import { NOTICE, type Repo } from "../store.ts";
import {
  applyLink,
  isBlocker,
  planTasksLink,
  resolveBbProject,
  type BbProject,
  type LinkPlan,
} from "../repos.ts";
import { setPushLevel } from "../push.ts";
import { V1_PRESETS } from "../roles.ts";
import { TasksError, type TasksPreset, type TasksProject } from "../tasks-client.ts";
import { ensureStorageRoot, JSON_OPTION, type CommandDeps } from "./deps.ts";
import { refreshIcon } from "../icon.ts";

export const CAPTAINS_PROJECT_NAME = "Captains";

/** What starting a Captain asks for; without `promptFile` the first message is `first-turn`. */
export type CaptainRequest = {
  name: string;
  repos: readonly string[];
  promptFile?: { path: string; read: () => Promise<string> };
};

/** A started or converged Captain. Steps after the spawn warn rather than fail. */
export type StartedCaptain = {
  threadId: string;
  state: "started" | "exists";
  name: string;
  homeProjectId: string;
  repos: Repo[];
  presetsCreated: string[];
  warnings: string[];
  /** Links and presets made, and the warnings, as `new` prints them. */
  notes: string[];
};

/**
 * Start a Captain, or converge the live one with this name: the one path the
 * CLI's `new` and the app's New Captain take. A refusal names every blocker
 * and changes nothing.
 */
export async function startCaptain(
  deps: CommandDeps,
  request: CaptainRequest,
): Promise<{ ok: true; captain: StartedCaptain } | { ok: false; blockers: Blocker[] }> {
  const planned = await plan(deps, request);
  if ("blockers" in planned) return { ok: false, blockers: planned.blockers };
  return { ok: true, captain: await apply(deps, planned) };
}

type Plan = {
  name: string;
  hostId: string;
  storageRoot: string;
  prompt: string;
  links: { project: BbProject; plan: LinkPlan }[];
  presets: TasksPreset[];
};

export function newCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Start a Captain thread on the bb server's machine, with its Drive and presets",
    options: {
      name: {
        type: "string",
        required: true,
        placeholder: "name",
        description:
          "The Captain's name, at most 80 characters; rerunning with a live name converges it",
      },
      repo: {
        type: "string",
        repeatable: true,
        split: ",",
        placeholder: "project",
        aliases: ["repos", "project"],
        description:
          "A bb project (id or name) this Captain directs; repeat or comma-separate; at least one",
      },
      "prompt-file": {
        type: "string",
        placeholder: "path",
        description: "The first message, read from this UTF-8 file on the invoking machine",
      },
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain new", json, async () => {
        // Crew would start or reconfigure a Captain that acts for them.
        await refuseCrew(deps, ctx, "start a Captain");
        const path = input.options["prompt-file"];
        const started = await startCaptain(deps, {
          name: input.options.name,
          repos: input.options.repo,
          ...(path === undefined
            ? {}
            : { promptFile: { path, read: () => readCallerFile(deps.bb, ctx, path) } }),
        });
        if (!started.ok) return refuse("captain new", started.blockers, json);
        const { notes, ...captain } = started.captain;
        const item: Item = {
          id: captain.threadId,
          ok: true,
          state: captain.state,
          detail: captain.name,
          data: {
            name: captain.name,
            homeProjectId: captain.homeProjectId,
            repos: captain.repos,
            presetsCreated: captain.presetsCreated,
            warnings: captain.warnings,
          },
        };
        return render([item], json, notes);
      });
    },
  });
}

/** Read and check everything before changing anything; collect every blocker. */
async function plan(
  deps: CommandDeps,
  args: CaptainRequest,
): Promise<Plan | { blockers: Blocker[] }> {
  const blockers: Blocker[] = [];
  const name = args.name.trim();
  if (name === "" || name.length > CAPTAIN_NAME_MAX || /[\r\n]/u.test(name)) {
    blockers.push({
      reason: `a Captain name is one line of 1 to ${CAPTAIN_NAME_MAX} characters`,
      fix: "pass --name <name>",
    });
  }
  if (args.repos.length === 0) {
    blockers.push({ reason: "a Captain directs at least one repo", fix: "pass --repo <project>" });
  }
  const { primaryHostId } = await deps.bb.sdk.system.config();
  const storageRoot = primaryHostId === null ? null : await ensureStorageRoot(deps);
  if (primaryHostId === null || storageRoot === null) {
    blockers.push({
      reason: "the bb server's machine has no thread storage yet",
      fix: "bb host list",
    });
  }
  const tasksProjects = await tasksRead(() => deps.tasks.listProjects(), blockers);
  const presets =
    tasksProjects === null ? null : await tasksRead(() => deps.tasks.listPresets(), blockers);
  const links = await planLinks(deps, args.repos, tasksProjects, blockers);
  let prompt = "";
  try {
    prompt =
      args.promptFile === undefined
        ? deps.files.read("first-turn", { name })
        : await args.promptFile.read();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    blockers.push(...error.blockers);
  }
  if (prompt.trim() === "" && args.promptFile !== undefined) {
    blockers.push({
      reason: `${args.promptFile.path} is empty`,
      fix: "write the Captain's purpose into it",
    });
  }
  if (blockers.length > 0 || primaryHostId === null || storageRoot === null || presets === null) {
    return { blockers };
  }
  return { name, hostId: primaryHostId, storageRoot, prompt, links, presets };
}

async function tasksRead<T>(read: () => Promise<T>, blockers: Blocker[]): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    blockers.push({
      reason: error.message,
      fix: "bb plugin list; enable it with bb plugin enable scott-tasks",
    });
    return null;
  }
}

async function planLinks(
  deps: CommandDeps,
  addresses: readonly string[],
  tasksProjects: readonly TasksProject[] | null,
  blockers: Blocker[],
): Promise<{ project: BbProject; plan: LinkPlan }[]> {
  if (addresses.length === 0) return [];
  const bbProjects = await deps.bb.sdk.projects.list();
  const used = new Set(tasksProjects?.map((project) => project.prefix));
  const links = new Map<string, { project: BbProject; plan: LinkPlan }>();
  for (const address of addresses) {
    const resolved = resolveBbProject(address, bbProjects);
    if ("blocker" in resolved) {
      blockers.push(resolved.blocker);
      continue;
    }
    if (tasksProjects === null || links.has(resolved.project.id)) continue;
    const planned = planTasksLink(resolved.project, tasksProjects, undefined, used);
    if (isBlocker(planned)) blockers.push(planned);
    else links.set(resolved.project.id, { project: resolved.project, plan: planned });
  }
  return [...links.values()];
}

/**
 * Spawn the Captain, or converge the live one with this name, then set up its
 * Drive, push level, GenUI mark and presets. Steps after the spawn warn rather
 * than fail, and each converges on a rerun.
 *
 * A new Captain spawns with its first message held, and that message is sent
 * only after the GenUI mark and the registry entry are written: bb resolves a
 * session's plugin configuration when the turn starts, so a turn started
 * earlier would run without GenUI and without the Captain's own tools.
 */
async function apply(deps: CommandDeps, plan: Plan): Promise<StartedCaptain> {
  const { bb, registry } = deps;
  const notes: string[] = [];
  const warnings: string[] = [];
  mkdirSync(deps.captainsDir, { recursive: true });
  // bb returns the existing project for a path it already has, so this is find-or-create.
  const home = await bb.sdk.projects.create({
    name: CAPTAINS_PROJECT_NAME,
    source: { type: "local_path", hostId: plan.hostId, path: deps.captainsDir },
  });
  const existing = registry.byName(plan.name);
  const repos = new Map((existing?.repos ?? []).map((repo) => [repo.bbProjectId, repo]));
  for (const { project, plan: link } of plan.links) {
    const { repo, note } = await applyLink(deps.tasks, project, link);
    repos.set(repo.bbProjectId, repo);
    if (note !== null) notes.push(note);
  }

  const threadId = existing?.threadId ?? (await spawnCaptain(deps, plan, home.id));
  warnings.push(...createDriveFiles(deps, join(plan.storageRoot, threadId)));
  registry.put({
    threadId,
    name: existing?.name ?? plan.name,
    homeProjectId: home.id,
    createdAt: existing?.createdAt ?? deps.now(),
    repos: [...repos.values()],
  });
  // Started with its name as its title: nothing for the suffix rename to do.
  if (existing === null) deps.store.markNoticeSent(NOTICE.titleSuffix(threadId), deps.now());
  bb.rpc.experimental_invalidate([CAPTAINS_TAG]);
  refreshIcon(deps, threadId);
  const pushWarning = await setPushLevel(bb, threadId);
  if (pushWarning !== null) warnings.push(pushWarning);
  // Also on a rerun, so `new` converges a Captain started before the mark.
  const audienceWarning = await markPersonFacing(bb, threadId);
  if (audienceWarning !== null) warnings.push(audienceWarning);
  if (existing === null) {
    const releaseWarning = await releaseFirstTurn(deps, threadId);
    if (releaseWarning !== null) warnings.push(releaseWarning);
  }
  const presets = await createMissingPresets(deps, plan.presets);
  warnings.push(...presets.warnings);
  if (presets.created.length > 0) notes.push(`created presets ${presets.created.join(", ")}`);
  notes.push(...warnings.map((warning) => `warning: ${warning}`));

  return {
    threadId,
    state: existing === null ? "started" : "exists",
    name: plan.name,
    homeProjectId: home.id,
    repos: [...repos.values()],
    presetsCreated: presets.created,
    warnings,
    notes,
  };
}

async function spawnCaptain(deps: CommandDeps, plan: Plan, projectId: string): Promise<string> {
  const thread = await deps.bb.sdk.threads.spawn({
    projectId,
    // Fixed, not checked: the Drive and `configure` need the server's disk, and
    // the Captain rules need Claude Code's background subagents.
    environment: {
      type: "host",
      hostId: plan.hostId,
      workspace: { type: "unmanaged", path: null },
    },
    providerId: "claude-code",
    // The user's call: Captains run unattended, and auto mode's classifier
    // refused their own `bb tasks show`.
    permissionMode: "full",
    // The sidebar icon marks it as a Captain, so the title is the name alone.
    title: plan.name,
    prompt: plan.prompt,
    pinned: true,
    pluginMetadata: { captain: { name: plan.name } },
    // Held so no turn starts before `apply` marks the thread; `releaseFirstTurn` sends it.
    sendAt: deps.now() + FIRST_TURN_HOLD_MS,
  });
  return thread.id;
}

/** How long a new Captain's first message waits if sending it now fails. */
const FIRST_TURN_HOLD_MS = 60_000;

/**
 * Send a new Captain's held first message now. Only the row Captain's own
 * `sendAt` holds is sent: a row another plugin or bb holds keeps its wait,
 * since send-now would override it. Returns a warning instead of failing.
 */
async function releaseFirstTurn(deps: CommandDeps, threadId: string): Promise<string | null> {
  try {
    const rows = await deps.bb.sdk.threads.queuedMessages.list({ threadId });
    for (const row of rows.filter((entry) => entry.waitingOn?.kind === "time")) {
      await deps.bb.sdk.threads.queuedMessages.send({
        threadId,
        queuedMessageId: row.id,
        mode: "auto",
      });
    }
    return null;
  } catch (error) {
    return `first message of ${threadId} not sent now; it starts when bb sends it: ${(error as Error).message}`;
  }
}

/** Create-only, so a rerun never clobbers what the Captain's first turn wrote. */
function createDriveFiles(deps: CommandDeps, dir: string): string[] {
  const warnings: string[] = [];
  for (const file of DRIVE_FILES) {
    try {
      deps.drive.write(join(dir, file), "", { createOnly: true });
    } catch (error) {
      warnings.push(`could not create ${file} in the Drive: ${(error as Error).message}`);
    }
  }
  return warnings;
}

/** Presets are global in Tasks with unique names, matched case-insensitively; existing ones are left alone. */
async function createMissingPresets(deps: CommandDeps, existing: readonly TasksPreset[]) {
  const names = new Set(existing.map((preset) => preset.name.toLowerCase()));
  const created: string[] = [];
  const warnings: string[] = [];
  for (const spec of V1_PRESETS.filter((preset) => !names.has(preset.name.toLowerCase()))) {
    try {
      await deps.tasks.createPreset(spec);
      created.push(spec.name);
    } catch (error) {
      warnings.push(`preset ${spec.name} not created: ${(error as Error).message}`);
    }
  }
  return { created, warnings };
}
