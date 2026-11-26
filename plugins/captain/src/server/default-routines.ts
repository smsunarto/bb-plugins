import type { InstructionFiles } from "@bb-plugins/instructions";
import {
  ROUTINES_PER_CAPTAIN,
  type RoutineFields,
  type RoutineView,
} from "../contract/routines.ts";
import { isNotFound } from "./audience.ts";
import { isMissing } from "./automations-client.ts";
import type { RoutineOwner } from "./routines.ts";
import type { Store } from "./store.ts";

/**
 * Built-in daily routines seeded once per Captain: created by `bb captain new`
 * and backfilled once for existing Captains. Each becomes an ordinary routine
 * the user can pause, edit, or remove; prompt bodies live under
 * `instructions/routines/`.
 */
export type DefaultRoutineSpec = {
  readonly name: string;
  readonly cron: string;
  /** Path relative to `instructions/` (without `.md`), read through `instructionFiles`. */
  readonly instructionFile: string;
};

/** Staggered by 30 minutes in the bb server's time zone so the two never land in one turn. */
export const DEFAULT_ROUTINES: readonly DefaultRoutineSpec[] = [
  {
    name: "Backlog grooming",
    cron: "0 9 * * *",
    instructionFile: "routines/backlog-grooming",
  },
  {
    name: "Drive sweep",
    cron: "30 9 * * *",
    instructionFile: "routines/drive-sweep",
  },
];

export type SeedResult = {
  /** False only when a transient error prevented seeding, so maintenance retries. */
  complete: boolean;
  created: RoutineView[];
  warnings: string[];
};

export type SeedDeps = {
  store: Pick<
    Store,
    | "captain"
    | "routinesOf"
    | "defaultRoutinesSeeded"
    | "markDefaultRoutinesSeeded"
    | "liveCaptains"
  >;
  files: InstructionFiles;
  now: () => number;
  timezone: string;
  isDisposed: () => boolean;
  isLiveInStore: (captainId: string) => boolean;
  getThread: (threadId: string) => Promise<{ deletedAt?: unknown; archivedAt: number | null }>;
  createRoutine: (captain: RoutineOwner, fields: RoutineFields) => Promise<RoutineView>;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function hasRoutineNamed(deps: Pick<SeedDeps, "store">, captainId: string, name: string): boolean {
  const wanted = name.toLowerCase();
  return deps.store.routinesOf(captainId).some((routine) => routine.name.toLowerCase() === wanted);
}

function capWarning(captainName: string, routineName: string): string {
  return `default routine ${JSON.stringify(routineName)} not added to ${captainName}: already at the ${ROUTINES_PER_CAPTAIN}-routine limit`;
}

/**
 * Read the Captain thread to decide whether defaults should be seeded now.
 * Deleted threads are marked seeded so later passes skip them quietly;
 * archived threads wait without failing maintenance.
 */
async function checkTarget(
  deps: SeedDeps,
  captain: RoutineOwner,
): Promise<{ state: "ready" | "skip" } | { state: "retry"; warning: string }> {
  if (!deps.isLiveInStore(captain.threadId)) return { state: "skip" };
  try {
    const thread = await deps.getThread(captain.threadId);
    if (deps.isDisposed()) return { state: "retry", warning: "" };
    if (thread.deletedAt != null) {
      deps.store.markDefaultRoutinesSeeded(captain.threadId, deps.now());
      return { state: "skip" };
    }
    return thread.archivedAt !== null ? { state: "skip" } : { state: "ready" };
  } catch (error) {
    if (deps.isDisposed()) return { state: "retry", warning: "" };
    if (isMissing(error) || isNotFound(error)) {
      deps.store.markDefaultRoutinesSeeded(captain.threadId, deps.now());
      return { state: "skip" };
    }
    return {
      state: "retry",
      warning: `default routines of ${captain.name} not seeded yet: ${errorText(error)}`,
    };
  }
}

type StepOutcome =
  | { outcome: "created"; view: RoutineView }
  | { outcome: "skipped"; warning?: string }
  | { outcome: "stop" }
  | { outcome: "retry"; warning: string };

/** Seed one built-in routine for a live Captain; existing names and full caps are skipped. */
async function seedOne(
  deps: SeedDeps,
  captain: RoutineOwner,
  spec: DefaultRoutineSpec,
): Promise<StepOutcome> {
  if (hasRoutineNamed(deps, captain.threadId, spec.name)) return { outcome: "skipped" };
  if (deps.store.routinesOf(captain.threadId).length >= ROUTINES_PER_CAPTAIN) {
    return { outcome: "skipped", warning: capWarning(captain.name, spec.name) };
  }
  try {
    const instruction = deps.files.read(spec.instructionFile);
    const view = await deps.createRoutine(captain, {
      name: spec.name,
      instruction,
      schedule: { cron: spec.cron, timezone: deps.timezone },
    });
    return { outcome: "created", view };
  } catch (error) {
    return classifyFailure(deps, captain, spec.name, error);
  }
}

function classifyFailure(
  deps: SeedDeps,
  captain: RoutineOwner,
  routineName: string,
  error: unknown,
): StepOutcome {
  if (deps.isDisposed()) return { outcome: "retry", warning: "" };
  if (hasRoutineNamed(deps, captain.threadId, routineName)) return { outcome: "skipped" };
  if (!deps.isLiveInStore(captain.threadId)) return { outcome: "stop" };
  if (deps.store.routinesOf(captain.threadId).length >= ROUTINES_PER_CAPTAIN) {
    return { outcome: "skipped", warning: capWarning(captain.name, routineName) };
  }
  return {
    outcome: "retry",
    warning: `default routine ${JSON.stringify(routineName)} not added to ${captain.name}: ${errorText(error)}`,
  };
}

async function seedAllSpecs(deps: SeedDeps, captain: RoutineOwner): Promise<SeedResult> {
  const created: RoutineView[] = [];
  const warnings: string[] = [];
  let complete = true;
  for (const spec of DEFAULT_ROUTINES) {
    if (deps.isDisposed()) return { complete: false, created, warnings };
    const step = await seedOne(deps, captain, spec);
    switch (step.outcome) {
      case "stop":
        return { complete: true, created, warnings };
      case "created":
        created.push(step.view);
        break;
      case "skipped":
        if (step.warning !== undefined) warnings.push(step.warning);
        break;
      case "retry":
        complete = false;
        if (step.warning !== "") warnings.push(step.warning);
        break;
    }
  }
  if (complete && !deps.isDisposed()) {
    deps.store.markDefaultRoutinesSeeded(captain.threadId, deps.now());
  }
  return { complete, created, warnings };
}

/**
 * Seed the built-in daily routines for one Captain once (caller holds the
 * per-Captain seed lock). Already-seeded Captains are left alone so a removed
 * default never returns; existing routines with the same name are kept as is.
 */
export async function seedCaptainDefaults(
  deps: SeedDeps,
  captain: RoutineOwner,
): Promise<SeedResult> {
  if (deps.isDisposed()) return { complete: false, created: [], warnings: [] };
  if (deps.store.defaultRoutinesSeeded(captain.threadId)) {
    return { complete: true, created: [], warnings: [] };
  }
  const target = await checkTarget(deps, captain);
  if (target.state === "skip") return { complete: true, created: [], warnings: [] };
  if (target.state === "retry") {
    return {
      complete: false,
      created: [],
      warnings: target.warning === "" ? [] : [target.warning],
    };
  }
  return seedAllSpecs(deps, captain);
}
