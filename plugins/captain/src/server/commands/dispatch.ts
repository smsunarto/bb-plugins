import { cliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import { callerCaptain } from "../caller.ts";
import {
  crewOnTask,
  isActive,
  readCrew,
  resolveTask,
  steer,
  tasksBlocker,
  type CrewThread,
} from "../crew.ts";
import { guard, refuse, Refusal, render, type Blocker, type Item } from "../output.ts";
import { setPushLevel } from "../push.ts";
import type { Captain } from "../registry.ts";
import { isDispatchable, parseRole, ROLE_SPECS, type Role } from "../roles.ts";
import { TasksError, type TasksPreset, type TasksTask } from "../tasks-client.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

/** One task and role to start, with everything resolved before anything spawns. */
type Unit = {
  task: TasksTask;
  role: Role;
  preset: TasksPreset;
  /** The base branch Tasks starts the worktree from, when one is set. */
  baseBranch: string | undefined;
  blockers: Blocker[];
};

type Plan = {
  captain: Captain;
  units: Unit[];
  /** The live crew as read during validation. */
  crew: CrewThread[];
};

type Flags = {
  again: boolean;
  dryRun: boolean;
  baseBranch: string | undefined;
  thread: string | undefined;
};

export function dispatchCommand(deps: CommandDeps) {
  /** Per-task guard: two dispatches of one task run one after the other; different tasks run in parallel. */
  const guards = new Map<string, Promise<void>>();

  async function withTaskGuard<T>(key: string, run: (waited: boolean) => Promise<T>): Promise<T> {
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
  }

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
        description:
          "Plan, Implement or Review; comma-separate roles that do not depend on each other",
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
      again: {
        type: "boolean",
        description: "Start another thread even when a live one has this task and role",
      },
      "dry-run": {
        type: "boolean",
        description: "Print the resolved preset, machine and branch without spawning",
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
        };
        const plan = await validate(deps, ctx, input.positionals.task, input.options, flags);
        if ("blockers" in plan) return refuse("captain dispatch", plan.blockers, json);
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
          );
        }
        if (flags.thread !== undefined) {
          const [unit] = plan.units;
          if (unit === undefined) throw new Error("adoption without a unit");
          return render([await adopt(deps, plan, unit, flags.thread, flags)], json);
        }
        const byTask = new Map<string, Unit[]>();
        for (const unit of plan.units) {
          byTask.set(unit.task.key, [...(byTask.get(unit.task.key) ?? []), unit]);
        }
        const notes: string[] = [];
        const results = await Promise.all(
          [...byTask].map(([key, units]) =>
            withTaskGuard(key, async (waited) => {
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
                const result = await dispatchUnit(deps, plan.captain, unit, crew, flags);
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

/** Read and check everything before spawning anything; collect every blocker. */
async function validate(
  deps: CommandDeps,
  ctx: PluginCliContext,
  keys: readonly string[],
  options: { role: string[]; captain?: string | undefined },
  flags: Flags,
): Promise<Plan | { blockers: Blocker[] }> {
  const captain = await callerCaptain(deps.bb, deps.registry, ctx, { captain: options.captain });
  const blockers: Blocker[] = [];
  const roles: Role[] = [];
  for (const name of options.role) {
    const role = parseRole(name);
    if (role === null || !isDispatchable(role)) {
      blockers.push({
        reason:
          role === null
            ? `no role ${JSON.stringify(name.trim())}`
            : `${ROLE_SPECS[role].label} is not started through dispatch in this version`,
        fix: "pass --role Plan, Implement or Review",
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
  if (flags.thread !== undefined && (uniqueKeys.length !== 1 || roles.length > 1)) {
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
  if (blockers.length > 0) return { blockers };

  let presets: TasksPreset[];
  let crew: CrewThread[];
  let resolved: ({ task: TasksTask } | { blocker: Blocker })[];
  try {
    [presets, crew, resolved] = await Promise.all([
      deps.tasks.listPresets(),
      readCrew(deps, captain.threadId),
      Promise.all(uniqueKeys.map((key) => resolveTask(deps, captain, key))),
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

  const units: Unit[] = [];
  for (const entry of resolved) {
    if (!("task" in entry)) continue;
    for (const role of roles) {
      const preset = presetOf.get(role);
      if (preset === undefined) continue;
      units.push(
        flags.thread === undefined
          ? requires(entry.task, role, preset, crew, flags.baseBranch)
          : { task: entry.task, role, preset, baseBranch: undefined, blockers: [] },
      );
    }
  }
  return { captain, units, crew };
}

/**
 * A role's `requires`. Review needs the task's Implement thread on its own
 * worktree, whose branch becomes Review's base: a shared checkout's branch is
 * `main` or the workspace branch, not the task's. `--base-branch` overrides it.
 * The `bug` triage gate on Plan and Implement arrives with Triage in Phase 5.
 */
function requires(
  task: TasksTask,
  role: Role,
  preset: TasksPreset,
  crew: readonly CrewThread[],
  baseBranch: string | undefined,
): Unit {
  const unit: Unit = { task, role, preset, baseBranch, blockers: [] };
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
      preset: unit.preset.name,
      baseBranch: unit.baseBranch ?? null,
    },
    ...(extra.blockers === undefined ? {} : { blockers: extra.blockers }),
  };
}

/** Start one unit, or report the live thread that already has it. */
async function dispatchUnit(
  deps: CommandDeps,
  captain: Captain,
  unit: Unit,
  crew: readonly CrewThread[],
  flags: Flags,
): Promise<{ item: Item; notes: string[] }> {
  const notes: string[] = [];
  const [existing] = crewOnTask(crew, unit.task.key, unit.role);
  if (existing !== undefined && !flags.again) {
    if (!flags.dryRun)
      notes.push(
        ...(await converge(deps, captain, unit, existing.thread.id, existing.thread.createdAt)),
      );
    return { item: unitItem(unit, "exists", { thread: existing.thread.id }), notes };
  }
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
        detail: `preset ${unit.preset.name} · machine ${machine} · branch ${branch}`,
      }),
      notes,
    };
  }

  const known = new Set(crew.map((member) => member.thread.id));
  deps.registry.setPending(captain.threadId, unit.task.key, unit.role);
  try {
    let threadId: string;
    try {
      threadId = await deps.tasks.delegate({
        taskId: unit.task.id,
        presetId: unit.preset.id,
        parentThreadId: captain.threadId,
        parentNotifications: "stuck",
        reportContract: deps.files.read("report"),
        extraInstructions: roleContract(deps, unit.role),
        ...(unit.baseBranch === undefined ? {} : { baseBranch: unit.baseBranch }),
      });
    } catch (error) {
      if (!(error instanceof TasksError)) throw error;
      const late = error.timedOut ? await findLateThread(deps, captain, unit, known) : null;
      if (late === null) {
        const reason = error.timedOut
          ? `${error.message}, and no new thread is on ${unit.task.key} yet`
          : error.message;
        return {
          item: unitItem(unit, "failed", {
            detail: reason,
            blockers: [
              {
                reason,
                fix: error.timedOut
                  ? `rerun bb captain dispatch ${unit.task.key} --role ${ROLE_SPECS[unit.role].label}; a thread that started late reports exists`
                  : "bb plugin list; check scott-tasks, then rerun",
              },
            ],
          }),
          notes,
        };
      }
      threadId = late;
      notes.push(`${unit.task.key}: Tasks did not answer in time; found its new thread ${late}`);
    }
    deps.store.putCrewRole({
      threadId,
      captainId: captain.threadId,
      role: unit.role,
      reportDueSince: deps.now(),
      contractSent: true,
    });
    const warning = await setPushLevel(deps.bb, threadId);
    if (warning !== null) notes.push(`warning: ${warning}`);
    return { item: unitItem(unit, "started", { thread: threadId }), notes };
  } finally {
    deps.registry.clearPending(captain.threadId, unit.task.key);
  }
}

/** After a deadline: a child of the Captain, new since validation, attached to this task. */
async function findLateThread(
  deps: CommandDeps,
  captain: Captain,
  unit: Unit,
  known: ReadonlySet<string>,
): Promise<string | null> {
  try {
    const crew = await readCrew(deps, captain.threadId);
    const fresh = crewOnTask(crew, unit.task.key).find(
      (member) =>
        !known.has(member.thread.id) && (member.role === null || member.role === unit.role),
    );
    return fresh?.thread.id ?? null;
  } catch (error) {
    if (error instanceof TasksError) return null;
    throw error;
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

/** The role's contract, carried into the first prompt whatever the session timing. */
function roleContract(deps: CommandDeps, role: Role): string {
  const contract = ROLE_SPECS[role].contract;
  return contract === null ? "" : deps.files.read(contract);
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
): Promise<Item> {
  const { captain } = plan;
  let thread;
  try {
    thread = await deps.bb.sdk.threads.get({ threadId });
  } catch (error) {
    throw new Refusal([
      { reason: `no thread ${threadId}: ${(error as Error).message}`, fix: "bb thread list" },
    ]);
  }
  const blockers: Blocker[] = [];
  if (thread.originKind !== null) {
    blockers.push({
      reason: `${threadId} is a fork, and bb never tells a fork's parent about its turns`,
      fix: `bb captain dispatch ${unit.task.key} --role ${ROLE_SPECS[unit.role].label} to start a new thread`,
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
  if (blockers.length > 0) throw new Refusal(blockers);
  const other = crewOnTask(plan.crew, unit.task.key, unit.role).find(
    (member) => member.thread.id !== threadId,
  );
  if (other !== undefined && !flags.again) {
    return unitItem(unit, "exists", {
      thread: other.thread.id,
      detail: `already has a live ${ROLE_SPECS[unit.role].label} thread; pass --again to add ${threadId}`,
    });
  }
  if (flags.dryRun) {
    return unitItem(unit, "planned", {
      thread: threadId,
      detail: "bring in: parent, stuck, attach",
    });
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
    return unitItem(unit, "failed", {
      thread: threadId,
      detail: error.message,
      blockers: [
        {
          reason: error.message,
          fix: `rerun bb captain dispatch ${unit.task.key} --thread ${threadId}`,
        },
      ],
    });
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
  }
  const notes: string[] = [];
  let contract = deps.store.crewRole(threadId)?.contractSent === true ? "sent" : "on first tell";
  if (contract !== "sent" && isActive(thread.status)) {
    try {
      await steer(deps.bb, threadId, adoptionContract(deps, captain, unit.role, unit.task.key));
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
  return { ...item, data: { ...item.data, contractSent: contract === "sent" } };
}
