import type { InstructionFiles } from "@bb-plugins/instructions";
import {
  ROUTINES_PER_CAPTAIN,
  type Routine,
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
  /** Stable per-routine key for the per-(captain, spec) seeded notice. */
  readonly key: string;
  readonly name: string;
  readonly cron: string;
  /** Path relative to `instructions/` (without `.md`), read through `instructionFiles`. */
  readonly instructionFile: string;
};

/** Staggered by 30 minutes in the bb server's time zone so the two never land in one turn. */
export const DEFAULT_ROUTINES: readonly DefaultRoutineSpec[] = [
  {
    key: "backlog-grooming",
    name: "Backlog grooming",
    cron: "0 9 * * *",
    instructionFile: "routines/backlog-grooming",
  },
  {
    key: "drive-sweep",
    name: "Drive sweep",
    cron: "30 9 * * *",
    instructionFile: "routines/drive-sweep",
  },
];

export type SeedResult = {
  /** False only when a transient error prevented seeding, so maintenance retries. */
  complete: boolean;
  warnings: string[];
};

export type SeedDeps = {
  store: Pick<Store, "routinesOf" | "defaultRoutineSeeded" | "markDefaultRoutineSeeded">;
  files: InstructionFiles;
  now: () => number;
  timezone: string;
  isDisposed: () => boolean;
  isLiveInStore: (captainId: string) => boolean;
  markArchived: (captainId: string) => void;
  getThread: (threadId: string) => Promise<{ deletedAt?: unknown; archivedAt: number | null }>;
  createRoutine: (captain: RoutineOwner, fields: RoutineFields) => Promise<RoutineView>;
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Built-in routines not yet marked seeded for this Captain. */
export function unseededSpecs(
  store: Pick<Store, "defaultRoutineSeeded">,
  captainId: string,
): DefaultRoutineSpec[] {
  return DEFAULT_ROUTINES.filter((spec) => !store.defaultRoutineSeeded(captainId, spec.key));
}

function hasRoutineNamed(routines: readonly Pick<Routine, "name">[], name: string): boolean {
  const wanted = name.toLowerCase();
  return routines.some((routine) => routine.name.toLowerCase() === wanted);
}

function capWarning(captainName: string, routineName: string): string {
  return `default routine ${JSON.stringify(routineName)} not added to ${captainName}: already at the ${ROUTINES_PER_CAPTAIN}-routine limit`;
}

function markAllSeeded(deps: SeedDeps, captainId: string): void {
  const at = deps.now();
  for (const spec of DEFAULT_ROUTINES) deps.store.markDefaultRoutineSeeded(captainId, spec.key, at);
}

/**
 * Read the Captain thread to decide whether defaults should be seeded now.
 * Deleted threads are marked seeded so later passes skip them quietly;
 * archived threads are recorded in `archived` and skipped without failing maintenance.
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
      markAllSeeded(deps, captain.threadId);
      return { state: "skip" };
    }
    if (thread.archivedAt !== null) {
      deps.markArchived(captain.threadId);
      return { state: "skip" };
    }
    return { state: "ready" };
  } catch (error) {
    if (deps.isDisposed()) return { state: "retry", warning: "" };
    if (isMissing(error) || isNotFound(error)) {
      markAllSeeded(deps, captain.threadId);
      return { state: "skip" };
    }
    return {
      state: "retry",
      warning: `default routines of ${captain.name} not seeded yet: ${errorMessage(error)}`,
    };
  }
}

type StepOutcome =
  | { outcome: "done"; warning?: string }
  | { outcome: "stop" }
  | { outcome: "retry"; warning: string };

/**
 * Seed one built-in routine for a live Captain and mark it seeded as soon as
 * it is created or skipped (by existing name or the 20-routine cap).
 */
async function seedOne(
  deps: SeedDeps,
  captain: RoutineOwner,
  spec: DefaultRoutineSpec,
): Promise<StepOutcome> {
  const existing = deps.store.routinesOf(captain.threadId);
  if (hasRoutineNamed(existing, spec.name)) {
    deps.store.markDefaultRoutineSeeded(captain.threadId, spec.key, deps.now());
    return { outcome: "done" };
  }
  if (existing.length >= ROUTINES_PER_CAPTAIN) {
    deps.store.markDefaultRoutineSeeded(captain.threadId, spec.key, deps.now());
    return { outcome: "done", warning: capWarning(captain.name, spec.name) };
  }
  try {
    const instruction = deps.files.read(spec.instructionFile);
    await deps.createRoutine(captain, {
      name: spec.name,
      instruction,
      schedule: { cron: spec.cron, timezone: deps.timezone },
    });
    if (!deps.isDisposed()) {
      deps.store.markDefaultRoutineSeeded(captain.threadId, spec.key, deps.now());
    }
    return { outcome: "done" };
  } catch (error) {
    return classifyFailure(deps, captain, spec, error);
  }
}

function classifyFailure(
  deps: SeedDeps,
  captain: RoutineOwner,
  spec: DefaultRoutineSpec,
  error: unknown,
): StepOutcome {
  if (deps.isDisposed()) return { outcome: "retry", warning: "" };
  const existing = deps.store.routinesOf(captain.threadId);
  if (hasRoutineNamed(existing, spec.name)) {
    deps.store.markDefaultRoutineSeeded(captain.threadId, spec.key, deps.now());
    return { outcome: "done" };
  }
  if (!deps.isLiveInStore(captain.threadId)) return { outcome: "stop" };
  if (existing.length >= ROUTINES_PER_CAPTAIN) {
    deps.store.markDefaultRoutineSeeded(captain.threadId, spec.key, deps.now());
    return { outcome: "done", warning: capWarning(captain.name, spec.name) };
  }
  return {
    outcome: "retry",
    warning: `default routine ${JSON.stringify(spec.name)} not added to ${captain.name}: ${errorMessage(error)}`,
  };
}

async function seedPendingSpecs(
  deps: SeedDeps,
  captain: RoutineOwner,
  pending: readonly DefaultRoutineSpec[],
): Promise<SeedResult> {
  const warnings: string[] = [];
  for (const spec of pending) {
    if (deps.isDisposed()) return { complete: false, warnings };
    const step = await seedOne(deps, captain, spec);
    if (step.outcome === "stop") return { complete: true, warnings };
    if (step.outcome === "retry") {
      if (step.warning !== "") warnings.push(step.warning);
      return { complete: false, warnings };
    }
    if (step.warning !== undefined) warnings.push(step.warning);
  }
  return { complete: true, warnings };
}

/**
 * Seed any unseeded built-in daily routines for one Captain (caller holds the
 * per-Captain seed lock). Each default is marked seeded as soon as it is
 * created or skipped, so a removed default never returns even after a partial
 * failure on another default.
 */
export async function seedCaptainDefaults(
  deps: SeedDeps,
  captain: RoutineOwner,
): Promise<SeedResult> {
  if (deps.isDisposed()) return { complete: false, warnings: [] };
  const pending = unseededSpecs(deps.store, captain.threadId);
  if (pending.length === 0) return { complete: true, warnings: [] };
  const target = await checkTarget(deps, captain);
  if (target.state === "skip") return { complete: true, warnings: [] };
  if (target.state === "retry") {
    return {
      complete: false,
      warnings: target.warning === "" ? [] : [target.warning],
    };
  }
  return seedPendingSpecs(deps, captain, pending);
}
