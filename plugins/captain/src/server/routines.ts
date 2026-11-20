import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { InstructionFiles } from "@bb-plugins/instructions";
import type { z } from "zod";
import {
  describeSchedule,
  oneShotDone,
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
import { Refusal } from "./output.ts";
import { NOTICE, type Cleanup, type Store } from "./store.ts";

/**
 * Routines: each is one script automation in bb Automations that calls the
 * hidden `bb captain routine fire`, which guards the run and sends the
 * Captain one message. Captain keeps no timer of its own; its maintenance
 * service repairs drift, retries failed Automations work and runs the away
 * pause, apart from the crew check.
 */

export type RoutinesDeps = {
  bb: Pick<BbPluginApi, "sdk" | "rpc" | "log">;
  store: Store;
  files: InstructionFiles;
  now: () => number;
  automations: AutomationsClient;
  /** Open the away ask for a live Captain and return its id; reruns return the open one. */
  openAwayAsk: (captainId: string, detail: string) => Promise<string>;
  /** The server machine's time zone, the default for `--timezone`. */
  defaultTimezone?: string;
};

/** The Captain a routine belongs to, as the service needs it. */
export type RoutineOwner = { threadId: string; name: string; homeProjectId: string };

/** Unseen this long while routines ran, a Captain's routines are paused with one ask. */
export const AWAY_PAUSE_AFTER_MS = 7 * 24 * 60 * 60_000;
export const AWAY_ASK_TEXT = "Routines paused while you were away";
export const AWAY_OPTIONS = ["Resume", "Keep paused"] as const;
/** Maintenance calls in flight at once, and the deadline on each. */
const MAINTENANCE_CONCURRENCY = 4;
const MAINTENANCE_DEADLINE_MS = 20_000;
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

export function createRoutines(deps: RoutinesDeps) {
  const { bb, store, automations } = deps;
  let reconciled = false;
  let reconcileWarned = false;

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

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const changed = (captainId: string) => bb.rpc.experimental_invalidate([routinesTag(captainId)]);
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

  /** Delete an automation now, or queue the delete for the next maintenance pass. */
  async function deleteAutomation(found: AutomationTarget): Promise<void> {
    try {
      await automations.delete(found);
    } catch (error) {
      if (isMissing(error)) return;
      store.addCleanup({ kind: "delete", ...found }, message(error), deps.now());
    }
  }

  /** Make a routine's automation; held by an away pause, it starts paused and stays held. */
  async function makeAutomation(owner: RoutineOwner, routine: Routine, enabled: boolean) {
    const held = store.awayHold(routine.id) !== null;
    const made = await automations.create(
      owner.homeProjectId,
      owner.name,
      routine,
      enabled && !held,
    );
    if (held) store.markAwayPaused(routine.id);
    return made.id;
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
        automationError: oneShotDone(routine)
          ? null
          : "no schedule; update the routine to schedule it again",
        done: oneShotDone(routine),
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
        done: oneShotDone(routine) && !status.enabled,
      };
    } catch (error) {
      return {
        ...base,
        automation: null,
        automationError: isMissing(error)
          ? "its automation was deleted; update the routine to schedule it again"
          : `Schedule unavailable: ${message(error)}`,
        done: false,
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
    // The insert reserves the name; the lock is taken before any await, so
    // reconcile never sees the automation before its id is saved.
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
    patch: Partial<z.input<typeof routineFieldsSchema>>,
  ): Promise<RoutineView> {
    return serial(`routine:${routine.id}`, async () => {
      const before = current(routine.id);
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
      const rearm = scheduleChanged && oneShotDone(before);
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
            if (rearm && store.awayHold(before.id) === null) await automations.resume(found);
          } catch (error) {
            if (!isMissing(error)) throw error;
            automationId = await remake();
          }
        }
      } catch (error) {
        if (nameChanged) store.updateRoutine(before.id, { name: before.name }, before.updatedAt);
        throw automationsRefused(error);
      }
      const saved = store.updateRoutine(before.id, { ...fields, automationId }, deps.now());
      changed(owner.threadId);
      return view(saved);
    });
  }

  /** Pause, resume, run now (Grok's Test) or delete. An explicit choice ends an away hold. */
  async function act(
    routine: Routine,
    action: RoutineAction,
  ): Promise<{ view: RoutineView | null; runId: string | null }> {
    return serial(`routine:${routine.id}`, async () => {
      const latest = current(routine.id);
      const owner = ownerOf(latest);
      if (action === "delete") {
        const found = target(latest);
        if (found !== null) await deleteAutomation(found);
        store.deleteRoutine(latest.id);
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
          // Durable, so a reload before the script's fire still finds it.
          store.addTestRun(runId, latest.id, deps.now());
        }
      } catch (error) {
        throw automationsRefused(error);
      }
      if (action !== "run") store.clearAway(latest.id);
      changed(owner.threadId);
      return { view: await view(latest), runId };
    });
  }

  function record(
    routine: Routine,
    trigger: RoutineRunTrigger,
    status: RoutineRun["status"],
    reason: string | null,
  ): RoutineRun {
    const run = store.recordRoutineRun({
      routineId: routine.id,
      trigger,
      status,
      reason,
      at: deps.now(),
    });
    changed(routine.captainId);
    return run;
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
      const captainRow = store.captain(routine.captainId);
      const thread = await bb.sdk.threads
        .get({ threadId: routine.captainId })
        .catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
      if (captainRow === null || thread === null || thread.deletedAt != null) {
        record(routine, trigger, "failed", "Captain deleted");
        void removeCaptain(routine.captainId, routine.id);
        throw new Refusal([
          { reason: `${routine.captainId} was deleted`, fix: "its routines are removed" },
        ]);
      }
      if (captainRow.archivedAt !== null || thread.archivedAt !== null) {
        record(routine, trigger, "failed", "Captain archived");
        // Inside this routine's lock: pause this one directly, the others after.
        await pauseOne(routine);
        void pauseCaptain(routine.captainId, routine.id);
        throw new Refusal([
          {
            reason: `${captainRow.name} Captain is archived`,
            fix: "its routines are paused; unarchive it and resume them",
          },
        ]);
      }
      const queued = await alreadyQueued(routine);
      if (queued !== false) {
        const reason = queued === "unreadable" ? "queue unreadable" : "previous run still queued";
        return { state: "skipped", run: record(routine, trigger, "skipped", reason) };
      }
      const wake = `${wakeToken(routine.id)}${JSON.stringify(routine.name)} · ${trigger === "test" ? "test" : "scheduled"}`;
      const text = `${wake}\n\n${deps.files.read("routine", {
        id: routine.id,
        instruction: routine.instruction,
        why: trigger === "test" ? "as a test run" : "on its schedule",
      })}`;
      try {
        const result = await bb.sdk.threads.send({
          threadId: routine.captainId,
          mode: "queue-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
        const state = result.delivery === "queued" ? "queued" : "sent";
        return { state, run: record(routine, trigger, state, null) };
      } catch (error) {
        record(routine, trigger, "failed", message(error));
        throw new Refusal([
          { reason: `not sent to the Captain: ${message(error)}`, fix: "the next run tries again" },
        ]);
      }
    });
  }

  /**
   * Whether the Captain's queue still holds a message this routine sent. A
   * queue that cannot be read counts as held: a send then could stack paid
   * turns behind the running one.
   */
  async function alreadyQueued(routine: Routine): Promise<boolean | "unreadable"> {
    try {
      const rows = await bb.sdk.threads.queuedMessages.list({ threadId: routine.captainId });
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
  async function removeCaptain(captainId: string, inLock?: string): Promise<void> {
    for (const routine of store.routinesOf(captainId)) {
      const remove = async () => {
        const latest = store.routine(routine.id);
        if (latest === null) return;
        const found = target(latest);
        if (found !== null) await deleteAutomation(found);
        store.deleteRoutine(latest.id);
      };
      if (routine.id === inLock) await remove();
      else await serial(`routine:${routine.id}`, remove);
    }
    changed(captainId);
  }

  /**
   * Converge with Automations once it lists: delete a Captain automation that
   * no routine owns, and queue a repair for a live Captain's routine whose
   * automation is gone. Returns true once listing worked and every orphan was
   * checked; failed deletes and repairs wait in the cleanup table.
   */
  async function reconcile(): Promise<boolean> {
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
        for (const row of await automations.listRoutineAutomations(projectId)) {
          listed.push({ projectId, ...row });
        }
      }
    } catch (error) {
      if (!reconcileWarned) bb.log.warn(`routines not reconciled yet: ${message(error)}`);
      reconcileWarned = true;
      return false;
    }
    const orphans = await mapLimit(listed, async (row) =>
      serial(`routine:${row.routineId}`, async () => {
        if (store.routine(row.routineId)?.automationId === row.automationId) return true;
        const found = { projectId: row.projectId, automationId: row.automationId };
        // Never delete what Captain did not make: the script and env must be exactly its own.
        if (!(await automations.ownedBy(found, row.routineId))) return true;
        await deleteAutomation(found);
        return true;
      }).catch((error: unknown) => {
        bb.log.warn(`automation ${row.automationId} not checked: ${message(error)}`);
        return false;
      }),
    );
    const known = new Set(listed.map((row) => row.automationId));
    await mapLimit(store.allRoutines(), (routine) =>
      serial(`routine:${routine.id}`, () => reschedule(routine.id, known)).catch(
        (error: unknown) => {
          store.addCleanup({ kind: "repair", routineId: routine.id }, message(error), deps.now());
        },
      ),
    );
    reconciled = orphans.every(Boolean);
    return reconciled;
  }

  /** Give a live Captain's routine an automation again when its own is gone. */
  async function reschedule(routineId: string, known?: ReadonlySet<string>): Promise<void> {
    const routine = store.routine(routineId);
    if (routine === null) return;
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
  async function drainCleanup(): Promise<void> {
    await mapLimit(store.cleanups(), async (cleanup: Cleanup) => {
      try {
        if (cleanup.kind === "delete") {
          await automations
            .delete({ projectId: cleanup.projectId, automationId: cleanup.automationId })
            .catch((error: unknown) => {
              if (!isMissing(error)) throw error;
            });
        } else {
          await serial(`routine:${cleanup.routineId}`, () => reschedule(cleanup.routineId));
        }
        store.removeCleanup(cleanup.key);
      } catch (error) {
        store.setCleanupError(cleanup.key, message(error));
      }
    });
  }

  /**
   * The away pause, as steps a restart resumes: choose the running routines
   * and claim the absence in one write, pause each (a failure is retried next
   * pass), then open one ask once all are paused.
   */
  async function awayPass(captainId: string): Promise<void> {
    const now = deps.now();
    const row = store.captain(captainId);
    if (row === null || row.archivedAt !== null) return;
    const seen = store.lastSeen(captainId) ?? row.createdAt;
    if (now - seen <= AWAY_PAUSE_AFTER_MS) return;
    const delivered = store.lastScheduledDelivery(captainId);
    if (delivered === null || delivered <= seen) return;
    const key = NOTICE.routinesAway(captainId, seen);
    if (store.noticeSentAt(key) === null) {
      const running: string[] = [];
      for (const routine of store.routinesOf(captainId)) {
        const found = target(routine);
        if (found === null || store.awayHold(routine.id) !== null) continue;
        // A failed read stops the choice; nothing is written, so the next pass chooses again.
        const status = await automations.get(found).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (status?.enabled === true) running.push(routine.id);
      }
      if (!store.startAway(key, captainId, seen, running, now)) return;
    }
    const holds = store.awayHolds({ captainId, absence: seen });
    for (const hold of holds.filter((entry) => !entry.paused)) {
      await serial(`routine:${hold.routineId}`, async () => {
        const routine = store.routine(hold.routineId);
        if (routine !== null) await pauseRunning(routine);
        store.markAwayPaused(hold.routineId);
      }).catch((error: unknown) =>
        bb.log.warn(`away pause of ${hold.routineId} retried next pass: ${message(error)}`),
      );
    }
    const after = store.awayHolds({ captainId, absence: seen });
    if (after.length === 0 || after.some((hold) => !hold.paused)) return;
    if (after.every((hold) => hold.askId !== null)) return;
    const names = after.map((hold) => {
      const routine = store.routine(hold.routineId);
      return routine === null
        ? hold.routineId
        : `${hold.routineId} ${JSON.stringify(routine.name)}`;
    });
    const askId = await deps.openAwayAsk(
      captainId,
      deps.files.read("routines-paused", {
        captain: row.name,
        days: Math.floor((now - seen) / (24 * 60 * 60_000)),
        routines: names.join(", "),
      }),
    );
    store.setAwayAsk(
      after.map((hold) => hold.routineId),
      askId,
    );
    changed(captainId);
  }

  /** Whether this ask is an away-pause ask still holding routines. */
  const isAwayAsk = (askId: string) => store.awayHolds({ askId }).length > 0;

  /**
   * Apply the answer to an away-pause ask: Resume resumes exactly the
   * routines it holds; any other answer leaves them paused. Each hold is
   * removed once handled, so a retry does only the rest. Returns a warning
   * when some could not be resumed yet.
   */
  async function applyAwayAnswer(askId: string, answer: string): Promise<string | null> {
    const holds = store.awayHolds({ askId });
    if (holds.length === 0) return null;
    const resume = answer.trim().toLowerCase() === "resume";
    const failed: string[] = [];
    for (const hold of holds) {
      await serial(`routine:${hold.routineId}`, async () => {
        const routine = store.routine(hold.routineId);
        const found = routine === null ? null : target(routine);
        try {
          if (resume && found !== null) await automations.resume(found);
        } catch (error) {
          if (!isMissing(error)) {
            failed.push(hold.routineId);
            return;
          }
        }
        store.clearAway(hold.routineId);
      });
    }
    changed(holds[0]?.captainId as string);
    return failed.length === 0
      ? null
      : `${failed.join(", ")} not resumed: bb Automations did not answer; the next pass retries`;
  }

  /**
   * One maintenance pass, off the crew check: reconcile until it has run,
   * retry queued cleanup, run the away pause per live Captain and apply
   * answered away asks. Each part runs with bounded concurrency and a
   * deadline, and its failure skips only itself. Returns whether work is left.
   */
  async function maintain(): Promise<{ pending: boolean }> {
    const step = async (name: string, work: () => Promise<unknown>) => {
      try {
        await withDeadline(work(), MAINTENANCE_DEADLINE_MS * 3);
      } catch (error) {
        bb.log.warn(`routine maintenance: ${name} skipped: ${message(error)}`);
      }
    };
    await step("reconcile", reconcile);
    await step("cleanup", drainCleanup);
    await step("away pause", () =>
      mapLimit(store.liveCaptains(), (captain) =>
        withDeadline(awayPass(captain.threadId), MAINTENANCE_DEADLINE_MS).catch((error: unknown) =>
          bb.log.warn(`away pause for ${captain.threadId} skipped: ${message(error)}`),
        ),
      ),
    );
    await step("away answers", async () => {
      const asks = new Set(
        store.awayHolds().flatMap((hold) => (hold.askId === null ? [] : [hold.askId])),
      );
      for (const askId of asks) {
        const ask = store.ask(askId);
        if (ask?.answer == null) continue;
        const warning = await applyAwayAnswer(askId, ask.answer);
        if (warning !== null) bb.log.warn(`away answer ${askId}: ${warning}`);
      }
    });
    const holdsLeft = store.awayHolds().some((hold) => !hold.paused || hold.askId === null);
    return { pending: !reconciled || store.cleanups().length > 0 || holdsLeft };
  }

  async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function mapLimit<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = Array.from({ length: items.length });
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await withDeadline(run(items[index] as T), MAINTENANCE_DEADLINE_MS).catch(
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
    reconcile,
    maintain,
    isAwayAsk,
    applyAwayAnswer,
    /** Register the maintenance service and the bb events that pause or remove a Captain's routines. */
    register(host: Pick<BbPluginApi, "events" | "background">): void {
      host.events.on("thread.archived", ({ thread }) => {
        if (store.captain(thread.id) === null) return;
        void pauseCaptain(thread.id).catch((error: unknown) =>
          bb.log.warn(`routines of ${thread.id} not paused: ${message(error)}`),
        );
      });
      host.events.on("thread.deleted", ({ thread }) => {
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
              pending = (await maintain()).pending;
            } catch (error) {
              bb.log.warn(`routine maintenance failed: ${message(error)}`);
            }
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
