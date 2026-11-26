import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { InstructionFiles } from "@bb-plugins/instructions";
import type { z } from "zod";
import {
  describeSchedule,
  oneShotDelivered,
  oneShotFired,
  routineFieldsSchema,
  routinesTag,
  type Routine,
  type RoutineAction,
  type RoutineFields,
  type RoutineRun,
  type RoutineRunTrigger,
  type RoutineView,
  type Schedule,
} from "../contract/routines.ts";
import { isMissing, type AutomationsClient, type AutomationTarget } from "./automations-client.ts";
import {
  errorMessage,
  seedCaptainDefaults,
  unseededSpecs,
  type SeedResult,
} from "./default-routines.ts";
import { Refusal } from "./output.ts";
import type { Cleanup, Store } from "./store.ts";

/**
 * Routines: each is one script automation in bb Automations that calls the
 * hidden `bb captain routine fire`, which guards the run and sends the
 * Captain one message. Captain keeps no timer of its own; its maintenance
 * service repairs drift and retries failed Automations work, apart from the
 * crew check.
 */

export type RoutinesDeps = {
  bb: Pick<BbPluginApi, "sdk" | "rpc" | "log" | "server" | "onDispose">;
  store: Store;
  files: InstructionFiles;
  now: () => number;
  automations: AutomationsClient;
  /** The server machine's time zone, the default for `--timezone`. */
  defaultTimezone?: string;
  /** How long one maintenance item runs before Captain warns; tests shorten it. */
  maintenanceDeadlineMs?: number;
  /** How long fire waits on one bb thread call; tests shorten it. */
  threadDeadlineMs?: number;
};

/** The Captain a routine belongs to, as the service needs it. */
export type RoutineOwner = { threadId: string; name: string; homeProjectId: string };

/** Maintenance calls in flight at once, and the deadline on each. */
const MAINTENANCE_CONCURRENCY = 4;
/** A test run's claim is dropped after this, in case its fire never came. */
const TEST_RUN_TTL_MS = 24 * 60 * 60_000;

/** Queue rows still waiting to reach the Captain; `failed_exhausted` never will. */
const PENDING_QUEUE_STATES = new Set([
  "queued",
  "scheduled",
  "waiting",
  "claimed",
  "failed_retrying",
]);

/** The routine's wake line: built here, not in `routine.md`, so the skip rule cannot drift from it. */
export function wakeToken(routineId: string): string {
  return `[captain] routine ${routineId} `;
}

export type FireResult = { state: "sent" | "queued" | "skipped"; run: RoutineRun };

export type Routines = ReturnType<typeof createRoutines>;

type RoutinePatch = Partial<z.input<typeof routineFieldsSchema>>;

export class StaleRoutine extends Refusal {
  constructor() {
    super([
      {
        reason: "this routine changed elsewhere since the form opened",
        fix: "reload the form and make the edit again",
      },
    ]);
  }
}

type DeliveryRecord = {
  routine: Routine;
  run: Omit<RoutineRun, "id" | "status" | "reason">;
};
type RecordDelivery = (
  delivery: DeliveryRecord,
  status: RoutineRun["status"],
  reason: string | null,
) => RoutineRun | null;
type DeliveryState = {
  pending: Set<string>;
  recorders: Set<RecordDelivery>;
  waiting?: ((recorder: RecordDelivery) => void)[];
};

// Plugin reload can re-evaluate this module while an SDK send is still pending.
const processState: typeof globalThis & { captainRoutineDeliveries?: Map<string, DeliveryState> } =
  globalThis;

export function createRoutines(deps: RoutinesDeps) {
  const { bb, store, automations } = deps;
  let reconciled = false;
  let reconcileWarned = false;
  let backfillWarned = false;
  let backfillInFlight: Promise<{ complete: boolean; warnings: string[] }> | null = null;

  const locks = new Map<string, Promise<unknown>>();
  /** One operation at a time per key; a failed one does not block the next. */
  function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    locks.set(key, run);
    void run
      .finally(() => {
        if (locks.get(key) === run) locks.delete(key);
      })
      .catch(() => {});
    return run;
  }

  /** The lock for a Captain's routine names. */
  const deadlineMs = deps.maintenanceDeadlineMs ?? 20_000;
  const threadDeadlineMs = deps.threadDeadlineMs ?? 10_000;
  const dataDir = bb.server.experimental_dataDir;
  const deliveries = (processState.captainRoutineDeliveries ??= new Map<string, DeliveryState>());
  const deliveryState = deliveries.get(dataDir) ?? {
    pending: new Set<string>(),
    recorders: new Set<RecordDelivery>(),
  };
  deliveries.set(dataDir, deliveryState);
  const { pending: delivering, recorders } = deliveryState;
  // A live upgrade can inherit this process state from an older generation.
  const waiting = (deliveryState.waiting ??= []);
  const changed = (captainId: string) => bb.rpc.experimental_invalidate([routinesTag(captainId)]);
  let disposed = false;
  const forgetDeliveryState = () => {
    if (
      deliveries.get(dataDir) === deliveryState &&
      delivering.size === 0 &&
      recorders.size === 0
    ) {
      deliveries.delete(dataDir);
    }
  };
  const persistDelivery: RecordDelivery = ({ routine, run }, status, reason) => {
    const latest = store.routine(routine.id);
    if (latest === null) return null;
    const sameSchedule =
      latest.automationId === routine.automationId &&
      JSON.stringify(latest.schedule) === JSON.stringify(routine.schedule);
    const recorded = store.recordRoutineRun({ ...run, status, reason }, sameSchedule);
    changed(routine.captainId);
    return recorded;
  };
  recorders.add(persistDelivery);
  bb.onDispose(() => {
    disposed = true;
    recorders.delete(persistDelivery);
    forgetDeliveryState();
  });
  for (const complete of waiting.splice(0)) complete(persistDelivery);

  function recordSettledDelivery(
    delivery: DeliveryRecord,
    status: RoutineRun["status"],
    reason: string | null,
  ): RoutineRun | null | Promise<RoutineRun | null> {
    const persist = [...recorders].at(-1);
    if (persist !== undefined) return persist(delivery, status, reason);
    // The watcher can stop Captain before loading the replacement. Keep both
    // the outcome and the in-flight claim until the replacement can record it.
    return new Promise((resolve, reject) => {
      waiting.push((recorder) => {
        try {
          resolve(recorder(delivery, status, reason));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function requireActiveGeneration(): void {
    if (disposed) {
      throw new Refusal([
        {
          reason: "Captain was reloaded before the operation finished",
          fix: "the next run tries again",
        },
      ]);
    }
  }

  /** Captains being removed: a create queued behind the removal is refused. */
  const removing = new Set<string>();
  const archived = new Set<string>();
  const namesKey = (captainId: string) => `names:${captainId}`;
  const message = errorMessage;
  const ownerOf = (routine: Routine): RoutineOwner => {
    const row = store.captain(routine.captainId);
    if (row === null)
      throw new Refusal([
        { reason: `routine ${routine.id} has no Captain`, fix: "bb captain routine list" },
      ]);
    return { threadId: row.threadId, name: row.name, homeProjectId: row.homeProjectId };
  };
  const target = (routine: Routine): AutomationTarget | null =>
    routine.automationId === null
      ? null
      : { projectId: ownerOf(routine).homeProjectId, automationId: routine.automationId };
  const requireTarget = (routine: Routine): AutomationTarget => {
    const found = target(routine);
    if (found !== null) return found;
    throw new Refusal([
      {
        reason: `routine ${routine.id} has no schedule`,
        fix: `bb captain routine update ${routine.id} --cron <cron> to schedule it again`,
      },
    ]);
  };
  /** The routine as it is now, inside its lock; refuses one deleted meanwhile. */
  const current = (routineId: string): Routine => {
    const found = store.routine(routineId);
    if (found !== null) return found;
    throw new Refusal([
      { reason: `routine ${routineId} was removed`, fix: "bb captain routine list" },
    ]);
  };
  const automationsRefused = (error: unknown): Refusal =>
    error instanceof Refusal
      ? error
      : new Refusal([
          {
            reason: `bb Automations did not take it: ${message(error)}`,
            fix: "check `bb plugin list` shows automations running, then rerun",
          },
        ]);

  const spent = (schedule: Schedule) => "at" in schedule && schedule.at <= deps.now();

  /**
   * Delete an automation whose intent is already recorded under `key`; the
   * record goes once the delete lands, else maintenance retries it.
   */
  async function settleDelete(key: string, found: AutomationTarget): Promise<void> {
    try {
      await automations.delete(found);
    } catch (error) {
      if (!isMissing(error)) {
        store.setCleanupError(key, message(error));
        return;
      }
    }
    store.removeCleanup(key);
  }

  /** Record the intent, then delete: an interruption leaves the job for maintenance. */
  async function deleteAutomation(found: AutomationTarget, routineId: string): Promise<void> {
    const key = store.addCleanup({ kind: "delete", ...found, routineId }, "pending", deps.now());
    await settleDelete(key, found);
  }

  /** Delete a routine and its automation: intent and local delete commit together. */
  async function retire(routine: Routine): Promise<void> {
    const found = target(routine);
    const key = store.retireRoutine(routine.id, found, deps.now());
    if (key !== null && found !== null) await settleDelete(key, found);
  }

  /** Make a routine's automation. */
  async function makeAutomation(owner: RoutineOwner, routine: Routine, enabled: boolean) {
    return (await automations.create(owner.homeProjectId, owner.name, routine, enabled)).id;
  }

  /**
   * Parse fields the way the CLI and the app share. A new one-shot must be in
   * the future; `newSchedule: false` keeps a spent one-shot editable by name
   * or instruction.
   */
  function parseFields(
    input: z.input<typeof routineFieldsSchema>,
    newSchedule = true,
  ): RoutineFields {
    const parsed = routineFieldsSchema.safeParse(input);
    if (!parsed.success) {
      throw new Refusal(
        parsed.error.issues.map((issue) => ({
          reason: `${issue.path.join(".") || "routine"}: ${issue.message}`,
          fix: "fix that field and rerun",
        })),
      );
    }
    if (newSchedule && spent(parsed.data.schedule)) {
      throw new Refusal([
        { reason: "a one-shot's time has passed", fix: "pass a later --at or --in" },
      ]);
    }
    return parsed.data;
  }

  function timezoneOf(schedule: Schedule): string | undefined {
    return "at" in schedule ? deps.defaultTimezone : schedule.timezone;
  }

  async function view(routine: Routine): Promise<RoutineView> {
    const base = {
      ...routine,
      when: describeSchedule(routine.schedule, timezoneOf(routine.schedule)),
      lastRun: store.routineRuns(routine.id, 1)[0] ?? null,
    };
    const found = target(routine);
    if (found === null) {
      return {
        ...base,
        automation: null,
        automationError: oneShotFired(routine)
          ? null
          : "no schedule; update the routine to schedule it again",
        done: oneShotDelivered(routine),
        missed: oneShotFired(routine) && !oneShotDelivered(routine),
      };
    }
    try {
      const status = await automations.get(found);
      return {
        ...base,
        automation: {
          enabled: status.enabled,
          nextRunAt: status.nextRunAt,
          lastRunAt: status.lastRunAt,
        },
        automationError: null,
        done: !status.enabled && oneShotDelivered(routine),
        missed: !status.enabled && oneShotFired(routine) && !oneShotDelivered(routine),
      };
    } catch (error) {
      return {
        ...base,
        automation: null,
        automationError: isMissing(error)
          ? "its automation was deleted; update the routine to schedule it again"
          : `Schedule unavailable: ${message(error)}`,
        done: false,
        missed: false,
      };
    }
  }

  /** Make a routine and its automation. When Automations refuses or is down, nothing is stored. */
  async function create(
    captain: RoutineOwner,
    input: z.input<typeof routineFieldsSchema>,
    options: { paused?: boolean } = {},
  ): Promise<RoutineView> {
    const fields = parseFields(input);
    // Name changes run one at a time per Captain, so a reservation another
    // operation later releases never refuses this one.
    return serial(namesKey(captain.threadId), async () => {
      // Native archive does not archive the registry row. Check after waiting for the name lock.
      const thread = await bounded(
        bb.sdk.threads.get({ threadId: captain.threadId }),
        "reading the Captain",
      ).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      const live = store.captain(captain.threadId);
      if (
        removing.has(captain.threadId) ||
        archived.has(captain.threadId) ||
        live === null ||
        live.archivedAt !== null ||
        thread === null ||
        thread.deletedAt != null ||
        thread.archivedAt !== null
      ) {
        throw new Refusal([
          { reason: `${captain.name} Captain is no longer live`, fix: "no routine was added" },
        ]);
      }
      // The insert reserves the name; the routine lock is taken before any
      // await, so reconcile never sees the automation before its id is saved.
      const draft = store.createRoutine({ ...fields, captainId: captain.threadId, at: deps.now() });
      return serial(`routine:${draft.id}`, async () => {
        let automationId: string;
        try {
          automationId = (
            await automations.create(
              captain.homeProjectId,
              captain.name,
              draft,
              options.paused !== true,
            )
          ).id;
        } catch (error) {
          store.deleteRoutine(draft.id);
          throw automationsRefused(error);
        }
        const saved = store.updateRoutine(draft.id, { automationId }, deps.now());
        changed(captain.threadId);
        return view(saved);
      });
    });
  }

  /**
   * Change a routine. A new name is reserved in the store before Automations
   * hears of it, so two renames never both reach it. Only changed fields are
   * sent. An automation deleted outside Captain is made again, so two never
   * schedule the same routine. A one-shot that already ran is armed again by
   * a new time; a paused one stays paused.
   */
  async function update(
    routine: Routine,
    patchFrom: RoutinePatch | ((committed: Routine) => RoutinePatch),
    expectedUpdatedAt?: number,
  ): Promise<RoutineView> {
    return serial(`routine:${routine.id}`, async () => {
      const before = current(routine.id);
      if (expectedUpdatedAt !== undefined && before.updatedAt !== expectedUpdatedAt)
        throw new StaleRoutine();
      const patch = typeof patchFrom === "function" ? patchFrom(before) : patchFrom;
      const fields = parseFields(
        {
          name: patch.name ?? before.name,
          instruction: patch.instruction ?? before.instruction,
          schedule: patch.schedule ?? before.schedule,
        },
        patch.schedule !== undefined,
      );
      const owner = ownerOf(before);
      const nameChanged = fields.name !== before.name;
      const scheduleChanged = JSON.stringify(fields.schedule) !== JSON.stringify(before.schedule);
      const rearm = scheduleChanged && oneShotFired(before);
      const apply = async () => {
        // Reserve the name now: a concurrent rename to it fails here, before any remote write.
        if (nameChanged) store.updateRoutine(before.id, { name: fields.name }, before.updatedAt);
        let automationId = before.automationId;
        try {
          const found = target(before);
          const remake = async () =>
            spent(fields.schedule) ? null : makeAutomation(owner, { ...before, ...fields }, true);
          if (found === null) {
            automationId = await remake();
          } else {
            try {
              if (nameChanged || scheduleChanged) {
                await automations.update(found, owner.name, {
                  ...(nameChanged ? { name: fields.name } : {}),
                  ...(scheduleChanged ? { schedule: fields.schedule } : {}),
                });
              } else {
                await automations.get(found);
              }
              if (rearm) await automations.resume(found);
            } catch (error) {
              if (!isMissing(error)) throw error;
              automationId = await remake();
            }
          }
        } catch (error) {
          if (nameChanged) store.updateRoutine(before.id, { name: before.name }, before.updatedAt);
          throw automationsRefused(error);
        }
        const saved = store.updateRoutine(
          before.id,
          { ...fields, automationId },
          Math.max(deps.now(), before.updatedAt + 1),
        );
        changed(owner.threadId);
        return view(saved);
      };
      // Lock order is routine, then names; create takes names, then a routine no one else holds.
      return nameChanged ? serial(namesKey(owner.threadId), apply) : apply();
    });
  }

  /** Pause, resume, run now (Grok's Test) or delete. */
  async function act(
    routine: Routine,
    action: RoutineAction,
  ): Promise<{ view: RoutineView | null; runId: string | null }> {
    return serial(`routine:${routine.id}`, async () => {
      requireActiveGeneration();
      const latest = current(routine.id);
      const owner = ownerOf(latest);
      if (action === "delete") {
        await retire(latest);
        changed(owner.threadId);
        return { view: null, runId: null };
      }
      const found = requireTarget(latest);
      let runId: string | null = null;
      try {
        if (action === "pause") await automations.pause(found);
        else if (action === "resume") await automations.resume(found);
        else {
          runId = (await automations.run(found)).run.id;
          requireActiveGeneration();
          // Durable, so a reload before the script's fire still finds it.
          store.addTestRun(runId, latest.id, deps.now());
        }
      } catch (error) {
        throw automationsRefused(error);
      }
      requireActiveGeneration();
      // A CLI toggle also supersedes any schedule snapshot the Overview read before it.
      const saved =
        action === "run"
          ? latest
          : store.updateRoutine(latest.id, {}, Math.max(deps.now(), latest.updatedAt + 1));
      changed(owner.threadId);
      return { view: await view(saved), runId };
    });
  }

  function record(
    { routine, run }: DeliveryRecord,
    status: RoutineRun["status"],
    reason: string | null,
  ): RoutineRun {
    const recorded = store.recordRoutineRun({ ...run, status, reason });
    changed(routine.captainId);
    return recorded;
  }

  /**
   * Deliver one run: the automation's script calls this. Refuses an
   * automation that no longer schedules the routine and an archived Captain,
   * whose routines it pauses. Skips while the Captain's queue still holds this
   * routine's last message, or cannot be read, so at most one run waits per
   * routine.
   */
  async function fire(
    routineId: string,
    call: { automationId: string; runId: string | null },
  ): Promise<FireResult> {
    return serial(`routine:${routineId}`, async () => {
      requireActiveGeneration();
      const routine = store.routine(routineId);
      if (routine === null) {
        throw new Refusal([
          {
            reason: `no routine ${routineId}`,
            fix: "nothing to run; Captain deletes the automation on its next start",
          },
        ]);
      }
      if (call.automationId !== routine.automationId) {
        throw new Refusal([
          {
            reason: `automation ${call.automationId || "(none)"} no longer schedules ${routine.id}`,
            fix: "nothing to run; Captain deletes the stale automation on its next start",
          },
        ]);
      }
      const trigger: RoutineRunTrigger =
        call.runId !== null && store.takeTestRun(call.runId, deps.now() - TEST_RUN_TTL_MS)
          ? "test"
          : "schedule";
      const delivery: DeliveryRecord = {
        routine,
        run: {
          routineId: routine.id,
          trigger,
          at: deps.now(),
          ...(trigger === "test" && call.runId !== null ? { automationRunId: call.runId } : {}),
        },
      };
      const captainRow = store.captain(routine.captainId);
      const thread = await bounded(
        bb.sdk.threads.get({ threadId: routine.captainId }),
        "reading the Captain",
      ).catch((error: unknown) => {
        requireActiveGeneration();
        if (isMissing(error)) return null;
        // Recorded, so a spent one-shot shows as missed with this reason.
        record(delivery, "failed", message(error));
        throw error;
      });
      requireActiveGeneration();
      if (captainRow === null || thread === null || thread.deletedAt != null) {
        record(delivery, "failed", "Captain deleted");
        void removeCaptain(routine.captainId).catch((error: unknown) =>
          bb.log.warn(`routines of ${routine.captainId} not removed: ${message(error)}`),
        );
        throw new Refusal([
          { reason: `${routine.captainId} was deleted`, fix: "its routines are removed" },
        ]);
      }
      if (captainRow.archivedAt !== null || thread.archivedAt !== null) {
        record(delivery, "failed", "Captain archived");
        // Inside this routine's lock: pause this one directly, the others after.
        await pauseOne(routine);
        requireActiveGeneration();
        void pauseCaptain(routine.captainId, routine.id);
        throw new Refusal([
          {
            reason: `${captainRow.name} Captain is archived`,
            fix: "its routines are paused; unarchive it and resume them",
          },
        ]);
      }
      if (delivering.has(routine.id)) {
        return {
          state: "skipped",
          run: record(delivery, "skipped", "previous delivery in flight"),
        };
      }
      const wake = `${wakeToken(routine.id)}${JSON.stringify(routine.name)} · ${trigger === "test" ? "test" : "scheduled"}`;
      const text = `${wake}\n\n${deps.files.read("routine", {
        id: routine.id,
        instruction: routine.instruction,
        why: trigger === "test" ? "as a test run" : "on its schedule",
      })}`;
      // Claim before reading the queue, so reload cannot create a second reader
      // with the same empty snapshot. Keep the claim through the send's settlement.
      const release = () => {
        delivering.delete(routine.id);
        forgetDeliveryState();
      };
      delivering.add(routine.id);
      let queued: Awaited<ReturnType<typeof alreadyQueued>>;
      try {
        queued = await alreadyQueued(routine);
        requireActiveGeneration();
      } catch (error) {
        release();
        throw error;
      }
      if (queued !== false) {
        release();
        const reason = queued === "unreadable" ? "queue unreadable" : "previous run still queued";
        return { state: "skipped", run: record(delivery, "skipped", reason) };
      }
      const send = async () =>
        bb.sdk.threads.send({
          threadId: routine.captainId,
          mode: "queue-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
      const outcome = send()
        .then(
          (result) => ({
            status: result.delivery === "queued" ? ("queued" as const) : ("sent" as const),
            reason: null,
          }),
          (error: unknown) => ({ status: "failed" as const, reason: message(error) }),
        )
        .then(async ({ status, reason }) => ({
          status,
          reason,
          run: await recordSettledDelivery(delivery, status, reason),
        }))
        .finally(release);
      let settled: Awaited<typeof outcome>;
      try {
        settled = await bounded(outcome, "sending the wake");
      } catch (error) {
        throw new Refusal([
          {
            reason: `no answer yet: ${message(error)}`,
            fix: "Captain records the run when bb answers; runs until then are skipped",
          },
        ]);
      }
      if (settled.status === "failed") {
        throw new Refusal([
          { reason: `not sent to the Captain: ${settled.reason}`, fix: "the next run tries again" },
        ]);
      }
      if (settled.run === null) {
        throw new Refusal([
          {
            reason: `routine ${routine.id} was retired during delivery`,
            fix: "bb captain routine list",
          },
        ]);
      }
      return { state: settled.status, run: settled.run };
    });
  }

  /**
   * Whether the Captain's queue still holds a message this routine sent. A
   * queue that cannot be read counts as held: a send then could stack paid
   * turns behind the running one.
   */
  async function alreadyQueued(routine: Routine): Promise<boolean | "unreadable"> {
    try {
      const rows = await bounded(
        bb.sdk.threads.queuedMessages.list({ threadId: routine.captainId }),
        "reading the queue",
      );
      const token = wakeToken(routine.id);
      return rows.some(
        (row) =>
          PENDING_QUEUE_STATES.has(row.state) &&
          row.content.some((part) => part.type === "text" && part.text.startsWith(token)),
      );
    } catch (error) {
      bb.log.warn(`queue of ${routine.captainId} not read for ${routine.id}: ${message(error)}`);
      return "unreadable";
    }
  }

  /** Pause one routine's automation; true when it was running. Throws when Automations fails. */
  async function pauseRunning(routine: Routine): Promise<boolean> {
    const found = target(routine);
    if (found === null) return false;
    try {
      const status = await automations.get(found);
      if (!status.enabled) return false;
      await automations.pause(found);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async function pauseOne(routine: Routine): Promise<boolean> {
    return pauseRunning(routine).catch((error: unknown) => {
      bb.log.warn(`routine ${routine.id} not paused: ${message(error)}`);
      return false;
    });
  }

  /** Pause every routine of a Captain; returns the ones that were running and now are not. */
  async function pauseCaptain(captainId: string, skip?: string): Promise<string[]> {
    const paused: string[] = [];
    for (const routine of store.routinesOf(captainId)) {
      if (routine.id === skip) continue;
      const done = await serial(`routine:${routine.id}`, async () => {
        const latest = store.routine(routine.id);
        return latest === null ? false : pauseOne(latest);
      });
      if (done) paused.push(routine.id);
    }
    if (paused.length > 0) changed(captainId);
    return paused;
  }

  /** Delete a deleted Captain's routines; an automation not deleted now is queued for cleanup. */
  async function removeCaptain(captainId: string): Promise<void> {
    // Creates still queued are refused. One already running inserted its row
    // and holds that routine's lock, so the loop below waits for it.
    removing.add(captainId);
    for (const routine of store.routinesOf(captainId)) {
      const remove = async () => {
        const latest = store.routine(routine.id);
        if (latest !== null) await retire(latest);
      };
      await serial(`routine:${routine.id}`, remove);
    }
    changed(captainId);
  }

  /**
   * Converge with Automations once it lists: delete a Captain automation that
   * no routine owns, and queue a repair for a live Captain's routine whose
   * automation is gone. Returns true once listing worked and every orphan was
   * checked; failed deletes and repairs wait in the cleanup table.
   */
  async function reconcile(signal?: AbortSignal): Promise<boolean> {
    if (reconciled) return true;
    const projects = new Set<string>();
    for (const routine of store.allRoutines()) {
      const owner = store.captain(routine.captainId);
      if (owner !== null) projects.add(owner.homeProjectId);
    }
    for (const captain of store.liveCaptains()) projects.add(captain.homeProjectId);
    for (const cleanup of store.cleanups()) {
      if (cleanup.kind === "delete") projects.add(cleanup.projectId);
    }
    const listed: { projectId: string; automationId: string; routineId: string }[] = [];
    try {
      for (const projectId of projects) {
        if (signal?.aborted === true) return false;
        for (const row of await automations.listRoutineAutomations(projectId)) {
          listed.push({ projectId, ...row });
        }
      }
    } catch (error) {
      if (!reconcileWarned) bb.log.warn(`routines not reconciled yet: ${message(error)}`);
      reconcileWarned = true;
      return false;
    }
    const orphans = await mapLimit(
      listed,
      async (row) =>
        serial(`routine:${row.routineId}`, async () => {
          if (store.routine(row.routineId)?.automationId === row.automationId) return true;
          const found = { projectId: row.projectId, automationId: row.automationId };
          // Never delete what Captain did not make: the script and env must be exactly its own.
          // An exact copy is deleted on purpose: it would fire this same routine a second time.
          if (!(await automations.ownedBy(found, row.routineId))) return true;
          await deleteAutomation(found, row.routineId);
          return true;
        }).catch((error: unknown) => {
          bb.log.warn(`automation ${row.automationId} not checked: ${message(error)}`);
          return false;
        }),
      signal,
    );
    const known = new Set(listed.map((row) => row.automationId));
    await mapLimit(
      store.allRoutines(),
      (routine) =>
        serial(`routine:${routine.id}`, () => reschedule(routine.id, known)).catch(
          (error: unknown) => {
            store.addCleanup({ kind: "repair", routineId: routine.id }, message(error), deps.now());
          },
        ),
      signal,
    );
    // A stopped pass skipped items, so it proves nothing.
    reconciled = signal?.aborted !== true && orphans.every(Boolean);
    return reconciled;
  }

  /** Give a live Captain's routine an automation again when its own is gone. */
  async function reschedule(routineId: string, known?: ReadonlySet<string>): Promise<void> {
    const routine = store.routine(routineId);
    if (
      routine === null ||
      (routine.automationId !== null && store.deletePending(routineId, routine.automationId))
    ) {
      return;
    }
    const owner = store.captain(routine.captainId);
    if (owner === null || owner.archivedAt !== null) return;
    if (routine.automationId !== null && known?.has(routine.automationId) === true) return;
    const found = target(routine);
    if (found !== null) {
      // Made after the list was read, or not listed: ask for it directly.
      const gone = await automations.get(found).then(
        () => false,
        (error: unknown) => {
          if (isMissing(error)) return true;
          throw error;
        },
      );
      if (!gone) return;
    }
    if (spent(routine.schedule)) {
      if (routine.automationId !== null)
        store.updateRoutine(routine.id, { automationId: null }, deps.now());
      return;
    }
    const automationId = await makeAutomation(
      { threadId: owner.threadId, name: owner.name, homeProjectId: owner.homeProjectId },
      routine,
      true,
    );
    store.updateRoutine(routine.id, { automationId }, deps.now());
    changed(routine.captainId);
  }

  /** Retry each queued delete and repair once; done ones leave the table. */
  async function drainCleanup(signal?: AbortSignal): Promise<void> {
    await mapLimit(
      store.cleanups(),
      async (cleanup: Cleanup) => {
        try {
          if (cleanup.kind === "delete") {
            const found = { projectId: cleanup.projectId, automationId: cleanup.automationId };
            // Recheck against the recorded basis: an automation changed since is no longer Captain's.
            const owned =
              cleanup.routineId === null
                ? false
                : await automations.ownedBy(found, cleanup.routineId).catch((error: unknown) => {
                    if (isMissing(error)) return null;
                    throw error;
                  });
            if (owned === true) {
              await automations.delete(found).catch((error: unknown) => {
                if (!isMissing(error)) throw error;
              });
            } else if (owned === false) {
              bb.log.warn(`delete of ${cleanup.automationId} dropped: it is no longer Captain's`);
            }
          } else {
            await serial(`routine:${cleanup.routineId}`, () => reschedule(cleanup.routineId));
          }
          store.removeCleanup(cleanup.key);
        } catch (error) {
          store.setCleanupError(cleanup.key, message(error));
        }
      },
      signal,
    );
  }

  const seedDeps = {
    store,
    files: deps.files,
    now: deps.now,
    timezone: deps.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    isDisposed: () => disposed,
    isLiveInStore: (captainId: string) => {
      const live = store.captain(captainId);
      return (
        !removing.has(captainId) &&
        !archived.has(captainId) &&
        live !== null &&
        live.archivedAt === null
      );
    },
    markArchived: (captainId: string) => {
      archived.add(captainId);
    },
    getThread: (threadId: string) =>
      bounded(bb.sdk.threads.get({ threadId }), "reading the Captain"),
    createRoutine: (captain: RoutineOwner, fields: RoutineFields) => create(captain, fields),
  };

  /**
   * Seed the built-in daily routines for one Captain once. Each default is
   * marked seeded on its own, so a default the user removed never returns.
   */
  async function seedDefaults(captain: RoutineOwner): Promise<SeedResult> {
    if (disposed) return { complete: false, warnings: [] };
    if (unseededSpecs(store, captain.threadId).length === 0) {
      return { complete: true, warnings: [] };
    }
    return serial(`seed:${captain.threadId}`, () => seedCaptainDefaults(seedDeps, captain));
  }

  /**
   * Seed built-in daily routines for every live, unarchived Captain with
   * unseeded defaults. Concurrent callers coalesce onto the in-flight pass,
   * and transient warnings are logged once until a pass completes.
   */
  async function backfillDefaults(
    signal?: AbortSignal,
  ): Promise<{ complete: boolean; warnings: string[] }> {
    const stopped = () => signal?.aborted === true || disposed;
    if (stopped()) return { complete: false, warnings: [] };
    if (backfillInFlight !== null) return backfillInFlight;
    const pass = (async () => {
      const unseeded = store
        .liveCaptains()
        .filter(
          (captain) =>
            !removing.has(captain.threadId) &&
            !archived.has(captain.threadId) &&
            unseededSpecs(store, captain.threadId).length > 0,
        );
      if (unseeded.length === 0) {
        backfillWarned = false;
        return { complete: true, warnings: [] };
      }
      const results = await mapLimit(
        unseeded,
        (captain) =>
          seedDefaults({
            threadId: captain.threadId,
            name: captain.name,
            homeProjectId: captain.homeProjectId,
          }),
        signal,
      );
      const complete =
        !stopped() &&
        results.length === unseeded.length &&
        results.every((result) => result?.complete === true);
      const warnings = results.flatMap((result) => result?.warnings ?? []);
      if (complete) {
        for (const warning of warnings) bb.log.warn(warning);
        backfillWarned = false;
      } else if (warnings.length > 0 && !backfillWarned) {
        for (const warning of warnings) bb.log.warn(warning);
        backfillWarned = true;
      }
      return { complete, warnings };
    })();
    backfillInFlight = pass;
    try {
      return await pass;
    } finally {
      if (backfillInFlight === pass) backfillInFlight = null;
    }
  }

  /**
   * One maintenance pass, off the crew check: seed any unseeded Captains'
   * defaults, reconcile until it has run, then retry queued cleanup. Each part
   * runs with bounded concurrency, and its failure skips only itself. Returns
   * whether work is left.
   */
  async function maintain(signal?: AbortSignal): Promise<{ pending: boolean }> {
    const step = async (name: string, work: () => Promise<unknown>) => {
      if (signal?.aborted === true) return;
      try {
        await slowWarning(work(), deadlineMs * 3, name);
      } catch (error) {
        bb.log.warn(`routine maintenance: ${name} skipped: ${message(error)}`);
      }
    };
    let defaultsComplete = false;
    await step("defaults", async () => {
      defaultsComplete = (await backfillDefaults(signal)).complete;
    });
    await step("reconcile", () => reconcile(signal));
    await step("cleanup", () => drainCleanup(signal));
    return { pending: !defaultsComplete || !reconciled || store.cleanups().length > 0 };
  }

  /**
   * Fail a thread call bb has not answered in time. These hold the routine
   * lock, and maintenance waits on that lock, so each must settle.
   */
  async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`bb did not answer ${what} in ${threadDeadlineMs / 1000}s`)),
        threadDeadlineMs,
      );
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Await work to the end, warning when it runs past `ms`. Automations calls
   * and fire's thread calls each carry a deadline, so the work settles; a worker keeps its
   * slot until then, which keeps concurrency bounded.
   */
  async function slowWarning<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    const timer = setTimeout(
      () => bb.log.warn(`routine maintenance: ${label} still running after ${ms / 1000}s`),
      ms,
    );
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  async function mapLimit<T, R>(
    items: readonly T[],
    run: (item: T) => Promise<R>,
    signal?: AbortSignal,
  ): Promise<R[]> {
    const results: R[] = Array.from({ length: items.length });
    let next = 0;
    const worker = async () => {
      while (next < items.length && signal?.aborted !== true) {
        const index = next++;
        results[index] = await slowWarning(run(items[index] as T), deadlineMs, "item").catch(
          (error: unknown) => {
            bb.log.warn(`routine maintenance item skipped: ${message(error)}`);
            return undefined as R;
          },
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAINTENANCE_CONCURRENCY, items.length) }, worker),
    );
    return results;
  }

  return {
    parseFields,
    view,
    list: (captainId: string) => Promise.all(store.routinesOf(captainId).map(view)),
    create,
    update,
    act,
    fire,
    pauseCaptain,
    removeCaptain,
    seedDefaults,
    backfillDefaults,
    reconcile,
    maintain,
    /** Register the maintenance service and the bb events that pause or remove a Captain's routines. */
    register(host: Pick<BbPluginApi, "events" | "background">): void {
      host.events.on("thread.archived", ({ thread }) => {
        if (store.captain(thread.id) === null) return;
        archived.add(thread.id);
        void pauseCaptain(thread.id).catch((error: unknown) =>
          bb.log.warn(`routines of ${thread.id} not paused: ${message(error)}`),
        );
      });
      host.events.on("thread.unarchived", ({ thread }) => {
        archived.delete(thread.id);
      });
      host.events.on("thread.deleted", ({ thread }) => {
        archived.delete(thread.id);
        if (store.captain(thread.id) === null) return;
        void removeCaptain(thread.id).catch((error: unknown) =>
          bb.log.warn(`routines of ${thread.id} not removed: ${message(error)}`),
        );
      });
      host.background.service("routines", {
        async start(signal) {
          while (!signal.aborted) {
            let pending = true;
            try {
              pending = (await maintain(signal)).pending;
            } catch (error) {
              bb.log.warn(`routine maintenance failed: ${message(error)}`);
            }
            // Stopped while that pass ran: leave now rather than wait out the sleep.
            if (signal.aborted) break;
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, pending ? 60_000 : 15 * 60_000);
              signal.addEventListener("abort", done, { once: true });
            });
          }
        },
      });
    },
  };
}
