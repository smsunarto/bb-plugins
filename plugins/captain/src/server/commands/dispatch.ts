import { cliCommand } from "@get-bb/plugin-sdk";
import { callerCaptain } from "../caller.ts";
import {
  crewOnTask,
  isActive,
  readCrew,
  resolveTask,
  steerCrew,
  tasksBlocker,
  type CrewThread,
} from "../crew.ts";
import { guard, refuse, Refusal, render, type Blocker, type Item } from "../output.ts";
import { rungLabel, type LadderRole } from "../../contract/ladder.ts";
import {
  pickRung,
  readPool,
  roleLadder,
  rungPresetName,
  type PoolView,
  type RungChoice,
} from "../ladder.ts";
import { setPushLevel } from "../push.ts";
import type { Captain } from "../registry.ts";
import { isDispatchable, parseRole, ROLE_SPECS, type Role } from "../roles.ts";
import { ensureRungPreset, roleContract, spawnCrew } from "../spawn.ts";
import { TasksError, type TasksPreset, type TasksTask } from "../tasks-client.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

/** One task and role to start, with everything resolved before anything spawns. */
type Unit = {
  task: TasksTask;
  role: Role;
  /** The role's own preset: the template for later rungs, and what `--thread` attaches. */
  preset: TasksPreset;
  /** The ladder rung it starts on; null when brought in with `--thread`. */
  choice: RungChoice | null;
  /** The base branch Tasks starts the worktree from, when one is set. */
  baseBranch: string | undefined;
  blockers: Blocker[];
};

type Plan = {
  captain: Captain;
  units: Unit[];
  /** The live crew as read during validation. */
  crew: CrewThread[];
  /** Every Tasks preset, as read during validation. */
  presets: TasksPreset[];
};

type Flags = {
  again: boolean;
  dryRun: boolean;
  baseBranch: string | undefined;
  thread: string | undefined;
  /** `--rung`: start on this rung, eligible or not; null when it is not a whole number from 1. */
  rung: number | null | undefined;
};

export function dispatchCommand(deps: CommandDeps) {
  return cliCommand({
    summary:
      "Start crew threads on tasks through Tasks' dispatch, with parent, stuck notifications, preset and requires checked",
    positionals: [
      {
        name: "task",
        required: true,
        variadic: true,
        description: "Task keys, such as PLUG-14; case-insensitive",
      },
    ],
    options: {
      role: {
        type: "string",
        required: true,
        repeatable: true,
        split: ",",
        placeholder: "role",
        description: "Implement or Review; comma-separate roles that do not depend on each other",
      },
      "base-branch": {
        type: "string",
        placeholder: "ref",
        description:
          "Start the worktree from this branch; Review defaults to its Implement thread's branch",
      },
      thread: {
        type: "string",
        placeholder: "thread-id",
        description: "Bring this existing thread in as the crew thread instead of spawning one",
      },
      rung: {
        type: "string",
        placeholder: "n",
        description:
          "Start on this rung of the role's model ladder, eligible or not; Captain settings list the rungs",
      },
      again: {
        type: "boolean",
        description: "Start another thread even when a live one has this task and role",
      },
      "dry-run": {
        type: "boolean",
        description: "Print the resolved rung, preset, machine and branch without spawning",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain dispatch", json, async () => {
        const flags: Flags = {
          again: input.options.again,
          dryRun: input.options["dry-run"],
          baseBranch: input.options["base-branch"]?.trim() || undefined,
          thread: input.options.thread?.trim() || undefined,
          rung: parseRungFlag(input.options.rung),
        };
        const captain = await callerCaptain(deps.bb, deps.registry, ctx, {
          captain: input.options.captain,
        });
        if (flags.thread !== undefined) {
          const adopted = await adoptThread(
            deps,
            captain,
            input.positionals.task,
            input.options.role,
            flags.thread,
            flags,
          );
          return render([adopted.item], json, adopted.notes);
        }
        const plan = await validate(
          deps,
          captain,
          input.positionals.task,
          input.options.role,
          flags,
        );
        if ("blockers" in plan) return refuse("captain dispatch", plan.blockers, json);
        const notes: string[] = [];
        const refused = plan.units.filter((unit) => unit.blockers.length > 0);
        if (refused.length > 0) {
          // Validate, then act: one refused unit starts nothing.
          return render(
            plan.units.map((unit) =>
              unit.blockers.length > 0
                ? unitItem(unit, "refused", { blockers: unit.blockers })
                : unitItem(unit, "held", {
                    detail: `nothing started: ${refused.length} refused`,
                  }),
            ),
            json,
            plan.poolUnread ? [POOL_UNREAD] : [],
          );
        }
        if (plan.poolUnread) notes.push(POOL_UNREAD);
        // One preset per role and rung, before the tasks start in parallel: two
        // starts creating the same preset would collide on Tasks' unique names.
        const rungPresets = flags.dryRun ? new Map() : await resolveRungPresets(deps, plan);
        const byTask = new Map<string, Unit[]>();
        for (const unit of plan.units) {
          byTask.set(unit.task.key, [...(byTask.get(unit.task.key) ?? []), unit]);
        }
        const results = await Promise.all(
          [...byTask].map(([key, units]) =>
            deps.taskGuard(key, async (waited) => {
              // A dispatch that waited on another of the same task must see that one's thread.
              let crew = plan.crew;
              if (waited) {
                try {
                  crew = await readCrew(deps, plan.captain.threadId);
                } catch (error) {
                  if (!(error instanceof TasksError)) throw error;
                  const blocker = {
                    ...tasksBlocker(error),
                    fix: `rerun bb captain dispatch ${key}`,
                  };
                  return units.map((unit) =>
                    unitItem(unit, "failed", { detail: error.message, blockers: [blocker] }),
                  );
                }
              }
              const items: Item[] = [];
              for (const unit of units) {
                const result = await dispatchUnit(deps, plan, unit, crew, flags, rungPresets);
                items.push(result.item);
                notes.push(...result.notes);
              }
              return items;
            }),
          ),
        );
        return render(results.flat(), json, notes);
      });
    },
  });
}

/**
 * Read and check everything before spawning anything; collect every blocker.
 * With `pendingTask`, `--thread` takes no key: the task does not exist yet,
 * and every other check runs as it would once it does.
 */
async function validate(
  deps: CommandDeps,
  captain: Captain,
  keys: readonly string[],
  roleNames: readonly string[],
  flags: Flags,
  pendingTask = false,
): Promise<(Plan & { poolUnread: boolean }) | { blockers: Blocker[] }> {
  const blockers: Blocker[] = [];
  if (flags.rung === null) {
    blockers.push({ reason: "--rung takes a whole number from 1", fix: "pass --rung 1, 2, ..." });
  }
  if (flags.thread !== undefined && flags.rung !== undefined) {
    blockers.push({
      reason: "--rung picks a new thread's model; a thread brought in with --thread keeps its own",
      fix: "drop --rung",
    });
  }
  const roles: Role[] = [];
  for (const name of roleNames) {
    const role = parseRole(name);
    if (name.trim().toLowerCase() === "plan") {
      // Plan was retired: Implement plans its own work before building.
      blockers.push({
        reason: "the Plan role is gone; Implement plans before it builds",
        fix: 'pass --role Implement; for research or design only, say "no code" in the brief',
      });
    } else if (role === null || !isDispatchable(role)) {
      blockers.push({
        reason:
          role === null
            ? `no role ${JSON.stringify(name.trim())}`
            : `${ROLE_SPECS[role].label} is not started through dispatch in this version`,
        fix: "pass --role Implement or Review",
      });
    } else if (!roles.includes(role)) roles.push(role);
  }
  if (roles.includes("implement") && roles.includes("review")) {
    blockers.push({
      reason: "Review needs an Implement thread, which does not exist until its dispatch returns",
      fix: "dispatch --role Implement first, then --role Review",
    });
  }
  const uniqueKeys = [...new Set(keys.map((key) => key.trim().toUpperCase()))];
  const taskCount = pendingTask ? 0 : 1;
  if (flags.thread !== undefined && (uniqueKeys.length !== taskCount || roles.length > 1)) {
    blockers.push({
      reason: "--thread brings one thread in for one task and one role",
      fix: "pass one task key and one --role with --thread",
    });
  }
  if (flags.thread !== undefined && flags.baseBranch !== undefined) {
    blockers.push({
      reason: "--base-branch applies to a new thread, not one brought in with --thread",
      fix: "drop --base-branch",
    });
  }
  const forced = flags.rung ?? undefined;
  for (const role of roles) {
    const { rungs } = roleLadder(deps.store, role as LadderRole);
    if (forced !== undefined && forced > rungs.length) {
      blockers.push({
        reason: `${ROLE_SPECS[role].label}'s ladder has ${rungs.length} rung${rungs.length === 1 ? "" : "s"}, not ${forced}`,
        fix: `pass --rung 1 to ${rungs.length}, or add a rung in Captain settings`,
      });
    }
  }
  if (blockers.length > 0) return { blockers };

  let presets: TasksPreset[];
  let crew: CrewThread[];
  let resolved: ({ task: TasksTask } | { blocker: Blocker })[];
  let pool: PoolView | null = null;
  // A forced rung and a thread brought in read no eligibility.
  const readsPool = flags.thread === undefined && forced === undefined;
  try {
    [presets, crew, resolved, pool] = await Promise.all([
      deps.tasks.listPresets(),
      readCrew(deps, captain.threadId),
      Promise.all(uniqueKeys.map((key) => resolveTask(deps, captain, key))),
      readsPool ? readPool(deps.bb) : Promise.resolve(null),
    ]);
  } catch (error) {
    if (error instanceof TasksError) return { blockers: [tasksBlocker(error)] };
    throw error;
  }
  const presetOf = new Map<Role, TasksPreset>();
  for (const role of roles) {
    const name = ROLE_SPECS[role].preset?.name ?? "";
    const preset = presets.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (preset === undefined) {
      blockers.push({
        reason: `Tasks has no ${name} preset`,
        fix: `bb captain new --name ${JSON.stringify(captain.name)} --repo ${captain.repos[0]?.bbProjectId ?? "<project>"}, which creates missing presets`,
      });
    } else presetOf.set(role, preset);
  }
  // A missing preset or a bad key refuses the whole command: nothing names the unit.
  const keyBlockers = resolved.flatMap((entry) => ("blocker" in entry ? [entry.blocker] : []));
  if (blockers.length > 0 || keyBlockers.length > 0)
    return { blockers: [...blockers, ...keyBlockers] };

  const now = deps.now();
  const units: Unit[] = [];
  for (const entry of resolved) {
    if (!("task" in entry)) continue;
    for (const role of roles) {
      const preset = presetOf.get(role);
      if (preset === undefined) continue;
      if (flags.thread !== undefined) {
        units.push({
          task: entry.task,
          role,
          preset,
          choice: null,
          baseBranch: undefined,
          blockers: [],
        });
        continue;
      }
      const unit = requires(entry.task, role, preset, crew, flags.baseBranch);
      const ladder = roleLadder(deps.store, role as LadderRole).rungs;
      const choice = pickRung(ladder, pool, now, { forced });
      // A live thread on the task and role reports exists; only a start needs a rung.
      const starts = flags.again || crewOnTask(crew, entry.task.key, role).length === 0;
      if (choice.rung === null && starts) {
        unit.blockers.push({
          reason: `no rung of ${ROLE_SPECS[role].label}'s ladder has an eligible account: ${choice.skipped.join("; ")}`,
          fix: `bb captain dispatch ${entry.task.key} --role ${ROLE_SPECS[role].label} --rung <n> to start on one anyway; bb pool status shows when accounts reset`,
        });
      } else if (choice.rung !== null) unit.choice = choice;
      units.push(unit);
    }
  }
  return { captain, units, crew, presets, poolUnread: readsPool && pool === null };
}

const rungKey = (role: Role, rung: number) => `${role}:${rung}`;

/** Each role and rung the units start on, its Captain-owned preset resolved once, in turn. */
async function resolveRungPresets(
  deps: CommandDeps,
  plan: Plan,
): Promise<Map<string, TasksPreset | TasksError>> {
  const resolved = new Map<string, TasksPreset | TasksError>();
  for (const unit of plan.units) {
    const choice = unit.choice;
    if (choice === null || resolved.has(rungKey(unit.role, choice.rung))) continue;
    let preset: TasksPreset | TasksError;
    try {
      preset = await ensureRungPreset(
        deps,
        unit.role as LadderRole,
        choice.rung,
        choice.spec,
        plan.presets,
      );
    } catch (error) {
      if (!(error instanceof TasksError)) throw error;
      preset = error;
    }
    resolved.set(rungKey(unit.role, choice.rung), preset);
  }
  return resolved;
}

const POOL_UNREAD =
  "note: Account Pooler status not read, so rung 1 was taken without an eligibility check";

/** `--rung`: undefined when absent, null when not a whole number from 1. */
function parseRungFlag(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return /^[1-9]\d*$/u.test(trimmed) ? Number(trimmed) : null;
}

/** `rung 2 codex gpt-6-astra high (forced)`, with the rungs passed over on the way. */
function rungDetail(choice: RungChoice): string {
  const head = `rung ${choice.rung} ${rungLabel(choice.spec)}${choice.forced ? " (forced)" : ""}`;
  return choice.skipped.length === 0 ? head : `${head}; skipped ${choice.skipped.join("; ")}`;
}

/**
 * A role's `requires`. Review needs the task's Implement thread on its own
 * worktree, whose branch becomes Review's base: a shared checkout's branch is
 * `main` or the workspace branch, not the task's. `--base-branch` overrides it.
 * The `bug` triage gate on Implement arrives with Triage in Phase 5.
 */
function requires(
  task: TasksTask,
  role: Role,
  preset: TasksPreset,
  crew: readonly CrewThread[],
  baseBranch: string | undefined,
): Unit {
  const unit: Unit = { task, role, preset, choice: null, baseBranch, blockers: [] };
  if (role !== "review" || baseBranch !== undefined) return unit;
  const [implement] = crewOnTask(crew, task.key, "implement");
  const fix = `bb captain dispatch ${task.key} --role Review --base-branch <task branch>`;
  if (implement === undefined) {
    unit.blockers.push({
      reason: `${task.key} has no live Implement thread`,
      fix: `bb captain dispatch ${task.key} --role Implement first, or ${fix}`,
    });
    return unit;
  }
  const { id, environmentIsWorktree, environmentBranchName } = implement.thread;
  if (environmentIsWorktree !== true || environmentBranchName === null) {
    const where =
      environmentIsWorktree !== true
        ? `a shared checkout${environmentBranchName === null ? "" : ` (${environmentBranchName})`}`
        : "a worktree with no branch";
    unit.blockers.push({
      reason: `${task.key}'s Implement thread ${id} runs in ${where}, not on its own branch`,
      fix,
    });
    return unit;
  }
  unit.baseBranch = environmentBranchName;
  return unit;
}

function unitItem(
  unit: Unit,
  state: string,
  extra: { thread?: string; detail?: string; blockers?: Blocker[]; ok?: boolean } = {},
): Item {
  const label = ROLE_SPECS[unit.role].label;
  const ok =
    extra.ok ??
    (state === "started" || state === "exists" || state === "planned" || state === "adopted");
  return {
    id: unit.task.key,
    ok,
    lead: `${extra.thread ?? "-"}  ${label}`,
    state,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    data: {
      thread: extra.thread ?? null,
      role: label,
      preset:
        unit.choice === null
          ? unit.preset.name
          : rungPresetName(unit.role as LadderRole, unit.choice.rung),
      rung: unit.choice?.rung ?? null,
      providerId: unit.choice?.spec.providerId ?? null,
      model: unit.choice?.spec.model ?? null,
      reasoningLevel: unit.choice?.spec.reasoningLevel ?? null,
      skipped: unit.choice?.skipped ?? [],
      baseBranch: unit.baseBranch ?? null,
    },
    ...(extra.blockers === undefined ? {} : { blockers: extra.blockers }),
  };
}

/** Start one unit, or report the live thread that already has it. */
async function dispatchUnit(
  deps: CommandDeps,
  plan: Plan,
  unit: Unit,
  crew: readonly CrewThread[],
  flags: Flags,
  rungPresets: ReadonlyMap<string, TasksPreset | TasksError>,
): Promise<{ item: Item; notes: string[] }> {
  const { captain } = plan;
  const notes: string[] = [];
  const [existing] = crewOnTask(crew, unit.task.key, unit.role);
  if (existing !== undefined && !flags.again) {
    if (!flags.dryRun)
      notes.push(
        ...(await converge(deps, captain, unit, existing.thread.id, existing.thread.createdAt)),
      );
    return { item: unitItem(unit, "exists", { thread: existing.thread.id }), notes };
  }
  const choice = unit.choice;
  if (choice === null) throw new Error("a new thread without a rung");
  const presetName = rungPresetName(unit.role as LadderRole, choice.rung);
  if (flags.dryRun) {
    const machine = unit.preset.machineId ?? "the repo's source machine";
    const branch =
      unit.baseBranch ??
      unit.preset.baseBranch ??
      (unit.preset.environmentKind === "new-worktree"
        ? "the default branch"
        : "the shared checkout");
    return {
      item: unitItem(unit, "planned", {
        detail: `${rungDetail(choice)} · preset ${presetName} · machine ${machine} · branch ${branch}`,
      }),
      notes,
    };
  }

  const retry = `rerun bb captain dispatch ${unit.task.key} --role ${ROLE_SPECS[unit.role].label}`;
  const preset = rungPresets.get(rungKey(unit.role, choice.rung));
  if (preset === undefined) throw new Error(`no preset resolved for ${presetName}`);
  if (preset instanceof TasksError) {
    const reason = `preset ${presetName} not set to ${rungLabel(choice.spec)}: ${preset.message}`;
    return {
      item: unitItem(unit, "failed", { detail: reason, blockers: [{ reason, fix: retry }] }),
      notes,
    };
  }
  try {
    const started = await spawnCrew(deps, captain, {
      taskId: unit.task.id,
      taskKey: unit.task.key,
      role: unit.role,
      preset,
      rung: choice.rung,
      baseBranch: unit.baseBranch,
      known: new Set(crew.map((member) => member.thread.id)),
    });
    notes.push(...started.notes);
    return {
      item: unitItem(unit, "started", { thread: started.threadId, detail: rungDetail(choice) }),
      notes,
    };
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    return {
      item: unitItem(unit, "failed", {
        detail: error.message,
        blockers: [
          {
            reason: error.message,
            fix: error.timedOut
              ? `${retry}; a thread that started late reports exists`
              : "bb plugin list; check scott-tasks, then rerun",
          },
        ],
      }),
      notes,
    };
  }
}

/**
 * Bring a thread found by retry to the state a fresh dispatch leaves: its
 * `crew_roles` row and push level. Both converge on a rerun.
 */
async function converge(
  deps: CommandDeps,
  captain: Captain,
  unit: Unit,
  threadId: string,
  createdAt: number,
): Promise<string[]> {
  if (deps.store.crewRole(threadId) !== null) return [];
  // A backfilled thread owes a report from its creation, so one that never reports reads as stalled.
  deps.store.ensureCrewRole({
    threadId,
    captainId: captain.threadId,
    role: unit.role,
    reportDueSince: createdAt,
    contractSent: true,
  });
  const warning = await setPushLevel(deps.bb, threadId);
  return warning === null ? [] : [`warning: ${warning}`];
}

/** What an adopted thread is told: the report contract and its role contract. */
export function adoptionContract(
  deps: CommandDeps,
  captain: Captain,
  role: Role,
  taskKey: string,
): string {
  return deps.files.read("adopted", {
    captain: JSON.stringify(captain.name),
    role: ROLE_SPECS[role].label,
    task: taskKey,
    report: deps.files.read("report"),
    contract: roleContract(deps, role),
  });
}

type Adoptee = Awaited<ReturnType<CommandDeps["bb"]["sdk"]["threads"]["get"]>>;

/** The thread to bring in, or a refusal naming it when bb has none. */
export async function readAdoptee(deps: CommandDeps, threadId: string): Promise<Adoptee> {
  try {
    return await deps.bb.sdk.threads.get({ threadId });
  } catch (error) {
    throw new Refusal([
      { reason: `no thread ${threadId}: ${(error as Error).message}`, fix: "bb thread list" },
    ]);
  }
}

/**
 * Why this thread cannot join this Captain's crew: a fork, archived, a Captain
 * itself, or another Captain's crew. Read before anything is written, so a
 * caller that creates a task first can refuse without leaving one behind.
 */
export function adoptionBlockers(
  deps: CommandDeps,
  captain: Captain,
  thread: Pick<Adoptee, "id" | "originKind" | "archivedAt" | "parentThreadId">,
  retry: { task: string; role: string } | null,
): Blocker[] {
  const threadId = thread.id;
  const blockers: Blocker[] = [];
  if (thread.originKind !== null) {
    blockers.push({
      reason: `${threadId} is a fork, and bb never tells a fork's parent about its turns`,
      fix:
        retry === null
          ? "start a new crew thread for this work instead"
          : `bb captain dispatch ${retry.task} --role ${retry.role} to start a new thread`,
    });
  }
  if (thread.archivedAt !== null) {
    blockers.push({ reason: `${threadId} is archived`, fix: `bb thread unarchive ${threadId}` });
  }
  if (deps.registry.get(threadId) !== null) {
    blockers.push({ reason: `${threadId} is a Captain`, fix: "pass a crew thread" });
  }
  const parent = deps.registry.get(thread.parentThreadId ?? null);
  if (parent !== null && parent.threadId !== captain.threadId) {
    blockers.push({
      reason: `${threadId} is crew of the ${parent.name} Captain`,
      fix: `bb thread update ${threadId} --clear-parent-thread first`,
    });
  }
  return blockers;
}

/**
 * `bb captain dispatch <task> --role <role> --thread <id>`: validate as
 * dispatch does, then bring the thread in. The CLI and the sidebar's Adopt
 * dialog both call this, so both set parent, notifications, the Tasks
 * attachment, the role record and the contract the same way. A refusal
 * throws `Refusal`, which each caller's guard turns into its own output.
 */
export async function adoptThread(
  deps: CommandDeps,
  captain: Captain,
  keys: readonly string[],
  roleNames: readonly string[],
  threadId: string,
  flags: Omit<Flags, "thread">,
): Promise<{ item: Item; notes: string[] }> {
  const withThread: Flags = { ...flags, thread: threadId };
  const plan = await validate(deps, captain, keys, roleNames, withThread);
  if ("blockers" in plan) throw new Refusal(plan.blockers);
  const [unit] = plan.units;
  if (unit === undefined) throw new Error("adoption without a unit");
  return await adopt(deps, plan, unit, threadId, withThread);
}

/**
 * Every refusal `adoptThread` would raise for one role, run before its task
 * exists: `validate` without a key, then the thread's own checks. A caller
 * that creates the task first runs this so a refusal creates nothing.
 */
export async function checkAdoption(
  deps: CommandDeps,
  captain: Captain,
  roleName: string,
  threadId: string,
): Promise<Blocker[]> {
  const flags: Flags = {
    again: false,
    dryRun: false,
    baseBranch: undefined,
    thread: threadId,
    rung: undefined,
  };
  const plan = await validate(deps, captain, [], [roleName], flags, true);
  if ("blockers" in plan) return plan.blockers;
  return adoptionBlockers(deps, captain, await readAdoptee(deps, threadId), null);
}

/**
 * Bring an existing thread into the crew: parent and `stuck`, attached to the
 * task with the role's preset, its role recorded. An active thread gets the
 * contract now; an idle one gets it with its first `tell`, so adopting never
 * starts a turn. Every step converges on a rerun.
 */
async function adopt(
  deps: CommandDeps,
  plan: Plan,
  unit: Unit,
  threadId: string,
  flags: Flags,
): Promise<{ item: Item; notes: string[] }> {
  const { captain } = plan;
  const thread = await readAdoptee(deps, threadId);
  const blockers = adoptionBlockers(deps, captain, thread, {
    task: unit.task.key,
    role: ROLE_SPECS[unit.role].label,
  });
  if (blockers.length > 0) throw new Refusal(blockers);
  const other = crewOnTask(plan.crew, unit.task.key, unit.role).find(
    (member) => member.thread.id !== threadId,
  );
  if (other !== undefined && !flags.again) {
    const item = unitItem(unit, "exists", {
      thread: other.thread.id,
      detail: `already has a live ${ROLE_SPECS[unit.role].label} thread; pass --again to add ${threadId}`,
    });
    return { item, notes: [] };
  }
  if (flags.dryRun) {
    const item = unitItem(unit, "planned", {
      thread: threadId,
      detail: "bring in: parent, stuck, attach",
    });
    return { item, notes: [] };
  }

  if (thread.parentThreadId !== captain.threadId || thread.parentNotifications !== "stuck") {
    await deps.bb.sdk.threads.update({
      threadId,
      parentThreadId: captain.threadId,
      parentNotifications: "stuck",
    });
  }
  try {
    await deps.tasks.attachThread({ taskId: unit.task.id, threadId, presetName: unit.preset.name });
  } catch (error) {
    if (!(error instanceof TasksError)) throw error;
    const item = unitItem(unit, "failed", {
      thread: threadId,
      detail: error.message,
      blockers: [
        {
          reason: error.message,
          fix: `rerun bb captain dispatch ${unit.task.key} --thread ${threadId}`,
        },
      ],
    });
    return { item, notes: [] };
  }
  const prior = deps.store.crewRole(threadId);
  if (prior === null || prior.captainId !== captain.threadId || prior.role !== unit.role) {
    deps.store.putCrewRole({
      threadId,
      captainId: captain.threadId,
      role: unit.role,
      reportDueSince: null,
      contractSent: false,
    });
    // New to this Captain: only rules from now on top its messages, and CREW.md
    // reaches it at its next session. A role change keeps rules already queued.
    if (prior?.captainId !== captain.threadId)
      deps.store.markRulesSeen(threadId, deps.store.latestRuleId(captain.threadId));
  }
  const notes: string[] = [];
  let contract = deps.store.crewRole(threadId)?.contractSent === true ? "sent" : "on first tell";
  if (contract !== "sent" && isActive(thread.status)) {
    try {
      await steerCrew(
        deps,
        captain,
        threadId,
        adoptionContract(deps, captain, unit.role, unit.task.key),
      );
      deps.store.setContractSent(threadId);
      deps.store.setReportDue(threadId, deps.now());
      contract = "sent";
    } catch (error) {
      notes.push(`contract not sent: ${(error as Error).message}`);
    }
  }
  const warning = await setPushLevel(deps.bb, threadId);
  if (warning !== null) notes.push(warning);
  const item = unitItem(unit, "adopted", {
    thread: threadId,
    detail: [`contract ${contract}`, ...notes].join("; "),
  });
  return {
    item: { ...item, data: { ...item.data, contractSent: contract === "sent" } },
    notes: await permissionWarnings(deps, threadId),
  };
}

/**
 * A Captain send names the Captain as sender, so bb treats it as an agent's
 * message and denies the turn's escalations instead of asking; only `full`
 * has none. One warning line for an adopted thread outside `full`; an
 * unreadable mode warns about nothing.
 */
async function permissionWarnings(
  deps: Pick<CommandDeps, "bb">,
  threadId: string,
): Promise<string[]> {
  const mode = await deps.bb.sdk.threads
    .defaultExecutionOptions({ threadId })
    .then((options) => options?.permissionMode ?? null)
    .catch(() => null);
  return mode === null || mode === "full"
    ? []
    : [
        `warning: ${threadId} runs in ${mode} permission mode; Captain tells cannot approve escalations for it`,
      ];
}
