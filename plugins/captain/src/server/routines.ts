import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { InstructionFiles } from "@bb-plugins/instructions";
import type { z } from "zod";
import {
  describeSchedule,
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
import type { Store } from "./store.ts";

/**
 * Routines: each is one script automation in bb Automations that calls the
 * hidden `bb captain routine fire`, which guards the run and sends the
 * Captain one message. Captain keeps no timer of its own.
 */

export type RoutinesDeps = {
  bb: Pick<BbPluginApi, "sdk" | "rpc" | "log">;
  store: Store;
  files: InstructionFiles;
  now: () => number;
  automations: AutomationsClient;
  /** The server machine's time zone, the default for `--timezone`. */
  defaultTimezone?: string;
};

/** The Captain a routine belongs to, as the service needs it. */
export type RoutineOwner = { threadId: string; name: string; homeProjectId: string };

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

export type FireResult =
  | { state: "sent" | "queued"; run: RoutineRun }
  | { state: "skipped"; run: RoutineRun };

export type Routines = ReturnType<typeof createRoutines>;

export function createRoutines(deps: RoutinesDeps) {
  const { bb, store, automations } = deps;
  /** Test runs Captain started, by Automations run id, until their `fire` arrives. */
  const pendingTests = new Set<string>();
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
  const automationsRefused = (error: unknown): Refusal =>
    error instanceof Refusal
      ? error
      : new Refusal([
          {
            reason: `bb Automations did not take it: ${(error as Error).message}`,
            fix: "check `bb plugin list` shows automations running, then rerun",
          },
        ]);

  const spent = (schedule: Schedule) => "at" in schedule && schedule.at <= deps.now();

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
        automationError: "no schedule; update the routine to schedule it again",
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
      };
    } catch (error) {
      return {
        ...base,
        automation: null,
        automationError: isMissing(error)
          ? "its automation was deleted; update the routine to schedule it again"
          : `Schedule unavailable: ${(error as Error).message}`,
      };
    }
  }

  function timezoneOf(schedule: Schedule): string | undefined {
    return "at" in schedule ? deps.defaultTimezone : schedule.timezone;
  }

  /** Make a routine and its automation. When Automations refuses or is down, nothing is stored. */
  async function create(
    captain: RoutineOwner,
    input: z.input<typeof routineFieldsSchema>,
    options: { paused?: boolean } = {},
  ): Promise<RoutineView> {
    const fields = parseFields(input);
    const draft = store.createRoutine({ ...fields, captainId: captain.threadId, at: deps.now() });
    // Taken before any await, so reconcile never sees the automation without its id saved.
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
   * Change a routine. A new name or schedule updates its one automation in
   * place; an automation deleted outside Captain is made again, so two never
   * schedule the same routine.
   */
  async function update(
    routine: Routine,
    patch: Partial<z.input<typeof routineFieldsSchema>>,
  ): Promise<RoutineView> {
    return serial(`routine:${routine.id}`, async () => {
      const current = store.routine(routine.id) ?? routine;
      const fields = parseFields(
        {
          name: patch.name ?? current.name,
          instruction: patch.instruction ?? current.instruction,
          schedule: patch.schedule ?? current.schedule,
        },
        patch.schedule !== undefined,
      );
      // Automations disables a one-shot after its run, so a new one-shot time arms it again.
      const rearm = patch.schedule !== undefined && "at" in fields.schedule;
      const owner = ownerOf(current);
      const taken = store.findRoutine(owner.threadId, fields.name);
      if (taken !== null && taken.id !== current.id) {
        throw new Refusal([
          {
            reason: `routine ${taken.id} is already named ${JSON.stringify(fields.name)}`,
            fix: "pick another --name",
          },
        ]);
      }
      let automationId = current.automationId;
      const scheduleChanged =
        fields.name !== current.name ||
        JSON.stringify(fields.schedule) !== JSON.stringify(current.schedule);
      try {
        const found = target(current);
        if (found === null && spent(fields.schedule)) {
          // A spent one-shot with no automation: only its words change.
        } else if (found === null) {
          automationId = (
            await automations.create(
              owner.homeProjectId,
              owner.name,
              { ...current, ...fields },
              true,
            )
          ).id;
        } else {
          try {
            // Only the instruction changed: still confirm the schedule exists.
            if (scheduleChanged) await automations.update(found, owner.name, fields);
            else await automations.get(found);
            if (rearm) await automations.resume(found);
          } catch (error) {
            if (!isMissing(error)) throw error;
            automationId = (
              await automations.create(
                owner.homeProjectId,
                owner.name,
                { ...current, ...fields },
                true,
              )
            ).id;
          }
        }
      } catch (error) {
        throw automationsRefused(error);
      }
      const saved = store.updateRoutine(current.id, { ...fields, automationId }, deps.now());
      changed(owner.threadId);
      return view(saved);
    });
  }

  /** Pause, resume, run now (Grok's Test) or delete. */
  async function act(
    routine: Routine,
    action: RoutineAction,
  ): Promise<{ view: RoutineView | null; runId: string | null }> {
    return serial(`routine:${routine.id}`, async () => {
      const current = store.routine(routine.id) ?? routine;
      const owner = ownerOf(current);
      if (action === "delete") {
        const found = target(current);
        if (found !== null) {
          await automations.delete(found).catch((error: unknown) => {
            if (!isMissing(error)) throw automationsRefused(error);
          });
        }
        store.deleteRoutine(current.id);
        changed(owner.threadId);
        return { view: null, runId: null };
      }
      const found = requireTarget(current);
      let runId: string | null = null;
      try {
        if (action === "pause") await automations.pause(found);
        else if (action === "resume") await automations.resume(found);
        else {
          runId = (await automations.run(found)).run.id;
          // Its `fire` waits on this lock, so it finds the id.
          pendingTests.add(runId);
        }
      } catch (error) {
        throw automationsRefused(error);
      }
      changed(owner.threadId);
      return { view: await view(current), runId };
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
   * routine's last message, so at most one run waits per routine.
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
        call.runId !== null && pendingTests.delete(call.runId) ? "test" : "schedule";
      const captainRow = store.captain(routine.captainId);
      const thread = await bb.sdk.threads
        .get({ threadId: routine.captainId })
        .catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
      if (captainRow === null || thread === null || thread.deletedAt != null) {
        record(routine, trigger, "failed", "Captain deleted");
        await removeCaptain(routine.captainId);
        throw new Refusal([
          { reason: `${routine.captainId} was deleted`, fix: "its routines are removed" },
        ]);
      }
      if (captainRow.archivedAt !== null || thread.archivedAt !== null) {
        record(routine, trigger, "failed", "Captain archived");
        // Inside this routine's lock: pause the others now, this one directly.
        await pauseOne(routine);
        void pauseCaptain(routine.captainId, routine.id);
        throw new Refusal([
          {
            reason: `${captainRow.name} Captain is archived`,
            fix: "its routines are paused; unarchive it and resume them",
          },
        ]);
      }
      if (await alreadyQueued(routine)) {
        return {
          state: "skipped",
          run: record(routine, trigger, "skipped", "previous run still queued"),
        };
      }
      const text = `${wakeToken(routine.id)}${JSON.stringify(routine.name)} · ${trigger === "test" ? "test" : "scheduled"}\n\n${deps.files.read(
        "routine",
        {
          id: routine.id,
          instruction: routine.instruction,
          why: trigger === "test" ? "as a test run" : "on its schedule",
        },
      )}`;
      try {
        const result = await bb.sdk.threads.send({
          threadId: routine.captainId,
          mode: "queue-if-active",
          input: [{ type: "text", text, mentions: [] }],
        });
        const state = result.delivery === "queued" ? "queued" : "sent";
        return { state, run: record(routine, trigger, state, null) };
      } catch (error) {
        record(routine, trigger, "failed", (error as Error).message);
        throw new Refusal([
          {
            reason: `not sent to the Captain: ${(error as Error).message}`,
            fix: "the next run tries again",
          },
        ]);
      }
    });
  }

  /** Whether the Captain's queue still holds a message this routine sent. A failed read does not block the send. */
  async function alreadyQueued(routine: Routine): Promise<boolean> {
    try {
      const rows = await bb.sdk.threads.queuedMessages.list({ threadId: routine.captainId });
      const token = wakeToken(routine.id);
      return rows.some(
        (row) =>
          PENDING_QUEUE_STATES.has(row.state) &&
          row.content.some((part) => part.type === "text" && part.text.startsWith(token)),
      );
    } catch (error) {
      bb.log.warn(
        `queue of ${routine.captainId} not read for ${routine.id}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  async function pauseOne(routine: Routine): Promise<boolean> {
    const found = target(routine);
    if (found === null) return false;
    try {
      const status = await automations.get(found);
      if (!status.enabled) return false;
      await automations.pause(found);
      return true;
    } catch (error) {
      if (!isMissing(error))
        bb.log.warn(`routine ${routine.id} not paused: ${(error as Error).message}`);
      return false;
    }
  }

  /** Pause every routine of a Captain; returns the ones that were running and now are not. */
  async function pauseCaptain(captainId: string, skip?: string): Promise<string[]> {
    const paused: string[] = [];
    for (const routine of store.routinesOf(captainId)) {
      if (routine.id === skip) continue;
      const done = await serial(`routine:${routine.id}`, () =>
        pauseOne(store.routine(routine.id) ?? routine),
      );
      if (done) paused.push(routine.id);
    }
    if (paused.length > 0) changed(captainId);
    return paused;
  }

  /** Delete a deleted Captain's routines and their automations. */
  async function removeCaptain(captainId: string): Promise<void> {
    for (const routine of store.routinesOf(captainId)) {
      const found = target(routine);
      if (found !== null) {
        await automations.delete(found).catch((error: unknown) => {
          if (!isMissing(error))
            bb.log.warn(`automation of ${routine.id} not deleted: ${(error as Error).message}`);
        });
      }
      store.deleteRoutine(routine.id);
    }
  }

  /**
   * Converge with Automations once it answers: delete an automation that no
   * routine owns, and schedule again a live Captain's routine whose
   * automation is gone, except a one-shot whose time has passed. Returns true
   * once it has run to the end; until then each call tries again.
   */
  async function reconcile(): Promise<boolean> {
    if (reconciled) return true;
    const projects = new Set(store.allRoutines().map((routine) => ownerOf(routine).homeProjectId));
    for (const captain of store.liveCaptains()) projects.add(captain.homeProjectId);
    const listed: { projectId: string; automationId: string; routineId: string }[] = [];
    try {
      for (const projectId of projects) {
        for (const row of await automations.listRoutineAutomations(projectId))
          listed.push({ projectId, ...row });
      }
    } catch (error) {
      if (!reconcileWarned) bb.log.warn(`routines not reconciled yet: ${(error as Error).message}`);
      reconcileWarned = true;
      return false;
    }
    for (const row of listed) {
      await serial(`routine:${row.routineId}`, async () => {
        if (store.routine(row.routineId)?.automationId === row.automationId) return;
        await automations
          .delete({ projectId: row.projectId, automationId: row.automationId })
          .catch((error: unknown) => {
            if (!isMissing(error))
              bb.log.warn(
                `orphan automation ${row.automationId} not deleted: ${(error as Error).message}`,
              );
          });
      });
    }
    const known = new Set(listed.map((row) => row.automationId));
    for (const routine of store.allRoutines()) {
      await serial(`routine:${routine.id}`, () => reschedule(routine.id, known)).catch(
        (error: unknown) =>
          bb.log.warn(`routine ${routine.id} not rescheduled: ${(error as Error).message}`),
      );
    }
    reconciled = true;
    return true;
  }

  async function reschedule(routineId: string, known: ReadonlySet<string>): Promise<void> {
    const routine = store.routine(routineId);
    if (routine === null) return;
    const owner = store.captain(routine.captainId);
    if (owner === null || owner.archivedAt !== null) return;
    if (routine.automationId !== null && known.has(routine.automationId)) return;
    const found = target(routine);
    if (found !== null) {
      // Made after the list was read, or listed under another project: ask for it directly.
      const gone = await automations.get(found).then(
        () => false,
        (error: unknown) => {
          if (isMissing(error)) return true;
          throw error;
        },
      );
      if (!gone) return;
    }
    if ("at" in routine.schedule && routine.schedule.at <= deps.now()) {
      if (routine.automationId !== null)
        store.updateRoutine(routine.id, { automationId: null }, deps.now());
      return;
    }
    const created = await automations.create(owner.homeProjectId, owner.name, routine, true);
    store.updateRoutine(routine.id, { automationId: created.id }, deps.now());
    changed(routine.captainId);
  }

  /**
   * Apply the answer to an away-pause ask: Resume resumes exactly the
   * routines that pass paused; any other answer leaves them paused. Each
   * routine's mark is cleared once handled, so a retry does only the rest.
   * Returns a warning when some could not be resumed yet.
   */
  async function applyAwayAnswer(askId: string, answer: string): Promise<string | null> {
    const marked = store.routinesAwayUnder(askId);
    if (marked.length === 0) return null;
    if (answer.trim().toLowerCase() !== "resume") {
      store.setRoutinesAway(
        marked.map((routine) => routine.id),
        null,
      );
      return null;
    }
    const failed: string[] = [];
    for (const routine of marked) {
      await serial(`routine:${routine.id}`, async () => {
        const found = target(store.routine(routine.id) ?? routine);
        try {
          if (found !== null) await automations.resume(found);
        } catch (error) {
          if (!isMissing(error)) {
            failed.push(routine.id);
            return;
          }
        }
        store.setRoutinesAway([routine.id], null);
      });
    }
    changed(marked[0]?.captainId as string);
    return failed.length === 0
      ? null
      : `${failed.join(", ")} not resumed: bb Automations did not answer; the next check retries`;
  }

  return {
    parseFields,
    applyAwayAnswer,
    view,
    list: (captainId: string) => Promise.all(store.routinesOf(captainId).map(view)),
    create,
    update,
    act,
    fire,
    pauseCaptain,
    removeCaptain,
    reconcile,
    /** Register the bb events that pause or remove a Captain's routines. */
    register(events: Pick<BbPluginApi, "events">["events"]): void {
      events.on("thread.archived", ({ thread }) => {
        if (store.captain(thread.id) === null) return;
        void pauseCaptain(thread.id).catch((error: unknown) =>
          bb.log.warn(`routines of ${thread.id} not paused: ${(error as Error).message}`),
        );
      });
      events.on("thread.deleted", ({ thread }) => {
        if (store.captain(thread.id) === null) return;
        void removeCaptain(thread.id).catch((error: unknown) =>
          bb.log.warn(`routines of ${thread.id} not removed: ${(error as Error).message}`),
        );
      });
    },
  };
}
