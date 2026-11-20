import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test } from "vitest";
import { ROUTINE_ENV, ROUTINE_SCRIPT } from "./automations-client.ts";
import { Refusal } from "./output.ts";
import type { RoutineOwner } from "./routines.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

const SWEEP = {
  name: "Stalled crew sweep",
  instruction: "Run bb captain status --all and nudge stalled crew.",
  schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
};

async function routineHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  const row = host.server.store.captain(captainId);
  if (row === null) throw new Error("no Captain row");
  const owner: RoutineOwner = {
    threadId: row.threadId,
    name: row.name,
    homeProjectId: row.homeProjectId,
  };
  return { host, captainId, owner, routines: host.server.routines };
}

const routineSends = (host: CaptainHost, captainId: string) =>
  host.sent.filter(
    (send) => send.threadId === captainId && send.text.startsWith("[captain] routine"),
  );

describe("create", () => {
  test("makes one script automation in the Captains project that calls fire", async () => {
    const { host, owner, routines } = await routineHost();
    const view = await routines.create(owner, SWEEP);

    const rows = [...host.automations.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: "proj_captains",
      name: "Captain Plugins · Stalled crew sweep",
      enabled: true,
      trigger: { triggerType: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
      execution: { mode: "script", script: ROUTINE_SCRIPT, env: { [ROUTINE_ENV]: view.id } },
    });
    expect(ROUTINE_SCRIPT).toContain('captain routine fire "$BB_CAPTAIN_ROUTINE_ID" --automation');
    expect(view).toMatchObject({
      id: "r1",
      automationId: rows[0]?.id,
      when: "Every weekday at 9:00 AM",
      automation: { enabled: true },
    });
  });

  test("a one-shot schedules a once trigger; --paused creates it paused", async () => {
    const { host, owner, routines } = await routineHost();
    const at = host.now() + 60_000;
    await routines.create(owner, { ...SWEEP, schedule: { at } }, { paused: true });
    expect([...host.automations.rows.values()][0]).toMatchObject({
      enabled: false,
      trigger: { triggerType: "once", runAt: at },
    });
  });

  test("when Automations refuses or is down, nothing is stored", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    host.automations.refuseCreate = "cron is invalid";
    await expect(routines.create(owner, SWEEP)).rejects.toThrow(/cron is invalid/);
    host.automations.refuseCreate = null;
    host.automations.down = true;
    await expect(routines.create(owner, SWEEP)).rejects.toBeInstanceOf(Refusal);
    expect(host.server.store.routinesOf(captainId)).toEqual([]);
    expect(host.automations.rows.size).toBe(0);
  });

  test("a past one-shot and a too-frequent cron are refused before Automations", async () => {
    const { host, owner, routines } = await routineHost();
    await expect(
      routines.create(owner, { ...SWEEP, schedule: { at: host.now() - 1 } }),
    ).rejects.toThrow(/passed/);
    await expect(
      routines.create(owner, { ...SWEEP, schedule: { cron: "*/5 * * * *", timezone: "UTC" } }),
    ).rejects.toThrow(/every 15 minutes/);
    expect(host.automations.calls).toEqual([]);
  });
});

describe("update and actions", () => {
  test("a new schedule updates the one automation in place", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const updated = await routines.update(created, {
      name: "Sweep",
      schedule: { cron: "0 10 * * 1", timezone: "Europe/Berlin" },
    });
    expect(host.automations.rows.size).toBe(1);
    expect(host.automations.rows.get(created.automationId as string)).toMatchObject({
      name: "Captain Plugins · Sweep",
      trigger: { cron: "0 10 * * 1", timezone: "Europe/Berlin" },
    });
    expect(updated).toMatchObject({ name: "Sweep", when: "Every Monday at 10:00 AM" });
  });

  test("an automation deleted outside Captain is made again, never doubled", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    host.automations.rows.clear();
    const updated = await routines.update(created, { instruction: "New words" });
    expect(host.automations.rows.size).toBe(1);
    expect(updated.automationId).not.toBe(created.automationId);
    expect(updated.instruction).toBe("New words");
  });

  test("a spent one-shot keeps its name editable, and a new time arms it again", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, {
      ...SWEEP,
      schedule: { at: host.now() + 60_000 },
    });
    const row = host.automations.rows.get(created.automationId as string);
    // The run came and went: Automations disables a once automation after it.
    host.setNow(host.now() + 120_000);
    await routines.fire(created.id, { automationId: created.automationId as string, runId: null });
    if (row !== undefined) row.enabled = false;
    expect((await routines.view(host.server.store.routine(created.id) as never)).done).toBe(true);

    const renamed = await routines.update(created, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(row?.enabled).toBe(false);

    const at = host.now() + 60_000;
    const rearmed = await routines.update(renamed, { schedule: { at } });
    expect(row).toMatchObject({ enabled: true, trigger: { triggerType: "once", runAt: at } });
    expect(rearmed.automation?.enabled).toBe(true);
    expect(rearmed.done).toBe(false);
    expect(host.automations.rows.size).toBe(1);
    // The rename sent only the name: the spent trigger would have been refused.
    const rename = host.automations.calls.find((call) => call.method === "automations_update");
    expect(rename?.input).not.toHaveProperty("trigger");
  });

  test("moving a paused one-shot's time keeps it paused (finding 4)", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(
      owner,
      { ...SWEEP, schedule: { at: host.now() + 60_000 } },
      { paused: true },
    );
    const moved = await routines.update(created, { schedule: { at: host.now() + 120_000 } });
    expect(moved.automation?.enabled).toBe(false);
    expect(host.automations.rows.get(created.automationId as string)?.enabled).toBe(false);
  });

  test("an update queued behind a delete is refused and makes nothing (finding 10)", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const removing = routines.act(created, "delete");
    const updating = routines.update(created, {
      schedule: { cron: "0 10 * * *", timezone: "UTC" },
    });
    await removing;
    await expect(updating).rejects.toThrow(/was removed/);
    expect(host.automations.rows.size).toBe(0);
  });

  test("two renames to one name: the loser's schedule is untouched (finding 11)", async () => {
    const { host, owner, routines } = await routineHost();
    const a = await routines.create(owner, SWEEP);
    const b = await routines.create(owner, { ...SWEEP, name: "Digest" });
    const next = { cron: "0 11 * * *", timezone: "UTC" };
    const results = await Promise.allSettled([
      routines.update(a, { name: "Same", schedule: next }),
      routines.update(b, { name: "Same", schedule: next }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const loser = results[0]?.status === "rejected" ? a : b;
    const stored = host.server.store.routine(loser.id);
    expect(stored?.schedule).toEqual(SWEEP.schedule);
    expect(host.automations.rows.get(loser.automationId as string)?.trigger).toMatchObject({
      cron: "0 9 * * 1-5",
    });
  });

  test("pause, resume and delete pass through", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const id = created.automationId as string;
    expect((await routines.act(created, "pause")).view?.automation?.enabled).toBe(false);
    expect(host.automations.rows.get(id)?.enabled).toBe(false);
    expect((await routines.act(created, "resume")).view?.automation?.enabled).toBe(true);
    await routines.act(created, "delete");
    expect(host.automations.rows.size).toBe(0);
    expect(host.server.store.routine(created.id)).toBeNull();
  });

  test("archiving a Captain pauses its automations; deleting it removes them", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const one = await routines.create(owner, SWEEP);
    const two = await routines.create(owner, { ...SWEEP, name: "Digest" });
    const thread = makeThreadResponse({ id: captainId, archivedAt: 5_000 });
    await host.harness.behavior.emitThreadEvent("thread.archived", { thread });
    await waitFor(() =>
      [one, two].every(
        (r) => host.automations.rows.get(r.automationId as string)?.enabled === false,
      ),
    );
    await host.harness.behavior.emitThreadEvent("thread.deleted", { thread });
    await waitFor(() => host.automations.rows.size === 0);
    expect(host.server.store.routinesOf(captainId)).toEqual([]);
  });
});

describe("fire", () => {
  test("sends the rendered routine with queue-if-active and records the run", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const result = await routines.fire(created.id, {
      automationId: created.automationId as string,
      runId: "arun_x",
    });
    expect(result.state).toBe("sent");
    const [send] = routineSends(host, captainId);
    expect(send?.mode).toBe("queue-if-active");
    expect(send?.text.split("\n")[0]).toBe('[captain] routine r1 "Stalled crew sweep" · scheduled');
    expect(send?.text).toContain(SWEEP.instruction);
    expect(send?.text).toContain("the user did not type it");
    expect(host.server.store.routineRuns(created.id)).toMatchObject([
      { trigger: "schedule", status: "sent", reason: null },
    ]);
  });

  test("refuses an automation that no longer schedules the routine", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    await expect(
      routines.fire(created.id, { automationId: "auto_old", runId: null }),
    ).rejects.toThrow(/no longer schedules r1/);
    await expect(routines.fire(created.id, { automationId: "", runId: null })).rejects.toThrow(
      Refusal,
    );
    expect(routineSends(host, captainId)).toEqual([]);
    expect(host.server.store.routineRuns(created.id)).toEqual([]);
  });

  test("refuses an archived Captain and pauses its routines", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const one = await routines.create(owner, SWEEP);
    const two = await routines.create(owner, { ...SWEEP, name: "Digest" });
    host.updateThread(captainId, { archivedAt: 9_000 });
    await expect(
      routines.fire(one.id, { automationId: one.automationId as string, runId: null }),
    ).rejects.toThrow(/archived/);
    await waitFor(() =>
      [one, two].every(
        (r) => host.automations.rows.get(r.automationId as string)?.enabled === false,
      ),
    );
    expect(routineSends(host, captainId)).toEqual([]);
    expect(host.server.store.routineRuns(one.id)).toMatchObject([
      { status: "failed", reason: "Captain archived" },
    ]);
  });

  test("three fires against a busy Captain send two messages and record one skip", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const call = { automationId: created.automationId as string, runId: null };
    host.busy.add(captainId);

    expect((await routines.fire(created.id, call)).state).toBe("queued");
    // The running turn ends; the queued run starts the next one, and the Captain is busy again.
    host.drainQueue(captainId);
    expect((await routines.fire(created.id, call)).state).toBe("queued");
    // That run is still waiting behind the turn: this one is skipped.
    expect((await routines.fire(created.id, call)).state).toBe("skipped");

    expect(routineSends(host, captainId)).toHaveLength(2);
    expect(host.server.store.routineRuns(created.id).map((run) => run.status)).toEqual([
      "skipped",
      "queued",
      "queued",
    ]);
    expect(host.server.store.routineRuns(created.id)[0]?.reason).toBe("previous run still queued");
  });

  test("another routine's queued message, or a failed row, does not skip this one", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    host.queued.set(captainId, [
      { ...queued('[captain] routine r10 "Other" · scheduled'), state: "queued" },
      {
        ...queued('[captain] routine r1 "Stalled crew sweep" · scheduled'),
        state: "failed_exhausted",
      },
    ]);
    const result = await routines.fire(created.id, {
      automationId: created.automationId as string,
      runId: null,
    });
    expect(result.state).toBe("sent");
  });

  test("a Test run started through Captain records trigger test", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    host.automations.onRun = async (row, runId) => {
      await routines.fire(row.execution.env?.[ROUTINE_ENV] as string, {
        automationId: row.id,
        runId,
      });
    };
    const { runId } = await routines.act(created, "run");
    expect(runId).toMatch(/^arun_/);
    await waitFor(() => routineSends(host, captainId).length === 1);
    expect(routineSends(host, captainId)[0]?.text.split("\n")[0]).toContain("· test");
    expect(host.server.store.routineRuns(created.id)).toMatchObject([{ trigger: "test" }]);
  });
});

describe("reconcile", () => {
  test("reschedules a routine whose automation is gone and deletes an orphan", async () => {
    const { host, owner, routines } = await routineHost();
    const kept = await routines.create(owner, SWEEP);
    const lost = await routines.create(owner, { ...SWEEP, name: "Digest" });
    const past = await routines.create(owner, {
      ...SWEEP,
      name: "Once",
      schedule: { at: host.now() + 1_000 },
    });
    host.automations.rows.delete(lost.automationId as string);
    host.automations.rows.delete(past.automationId as string);
    host.automations.rows.set("auto_orphan", {
      id: "auto_orphan",
      projectId: "proj_captains",
      name: "Captain Plugins · gone",
      enabled: true,
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      execution: { mode: "script", script: ROUTINE_SCRIPT, env: { [ROUTINE_ENV]: "r99" } },
      runs: [],
    });
    // Copied config with the same env key but its own script: not Captain's to delete.
    host.automations.rows.set("auto_foreign", {
      id: "auto_foreign",
      projectId: "proj_captains",
      name: "Someone else",
      enabled: true,
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      execution: { mode: "script", script: "echo hi", env: { [ROUTINE_ENV]: "r98" } },
      runs: [],
    });
    host.setNow(host.now() + 5_000);

    expect(await routines.reconcile()).toBe(true);

    const store = host.server.store;
    expect(host.automations.rows.has("auto_orphan")).toBe(false);
    expect(host.automations.rows.has("auto_foreign")).toBe(true);
    expect(host.automations.rows.has(kept.automationId as string)).toBe(true);
    const relost = store.routine(lost.id);
    expect(relost?.automationId).not.toBe(lost.automationId);
    expect(host.automations.rows.has(relost?.automationId as string)).toBe(true);
    // The one-shot's time passed while its automation was gone: it is not made again.
    expect(store.routine(past.id)?.automationId).toBeNull();
    expect(host.automations.rows.size).toBe(3);
  });

  test("retries until Automations answers, then runs once", async () => {
    const { host, owner, routines } = await routineHost();
    await routines.create(owner, SWEEP);
    host.automations.down = true;
    expect(await routines.reconcile()).toBe(false);
    host.automations.down = false;
    expect(await routines.reconcile()).toBe(true);
    const calls = host.automations.calls.length;
    expect(await routines.reconcile()).toBe(true);
    expect(host.automations.calls.length).toBe(calls);
  });
});

describe("durability", () => {
  test("an unreadable queue skips the run and sends nothing (finding 3)", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    host.harness.sdk.stub("threads.queuedMessages.list", async () => {
      throw new Error("queue read timed out");
    });
    const result = await routines.fire(created.id, {
      automationId: created.automationId as string,
      runId: null,
    });
    expect(result).toMatchObject({ state: "skipped", run: { reason: "queue unreadable" } });
    expect(routineSends(host, captainId)).toEqual([]);
  });

  test("a test run stays a test run across a reload (finding 13)", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const { runId } = await routines.act(created, "run");
    await host.reload();
    await host.server.routines.fire(created.id, {
      automationId: created.automationId as string,
      runId,
    });
    expect(routineSends(host, captainId)[0]?.text.split("\n")[0]).toContain("· test");
    expect(host.server.store.routineRuns(created.id)).toMatchObject([{ trigger: "test" }]);
    expect(host.server.store.routine(created.id)?.deliveredAt).toBeNull();
  });

  test("a failed repair stays pending and is retried (finding 8)", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    host.automations.rows.delete(created.automationId as string);
    host.automations.refuseCreate = "Automations busy";
    expect((await routines.maintain()).pending).toBe(true);
    expect(host.server.store.cleanups()).toMatchObject([{ kind: "repair", routineId: created.id }]);
    expect(host.automations.rows.size).toBe(0);

    host.automations.refuseCreate = null;
    expect((await routines.maintain()).pending).toBe(false);
    expect(host.server.store.cleanups()).toEqual([]);
    expect(host.automations.rows.size).toBe(1);
  });

  test("a failed delete of a deleted Captain's automation is retried (finding 9)", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    host.automations.down = true;
    await routines.removeCaptain(captainId);
    expect(host.server.store.routinesOf(captainId)).toEqual([]);
    expect(host.server.store.cleanups()).toMatchObject([
      { kind: "delete", automationId: created.automationId },
    ]);
    host.automations.down = false;
    await routines.maintain();
    expect(host.automations.rows.size).toBe(0);
    expect(host.server.store.cleanups()).toEqual([]);
  });

  test("the crew check makes no Automations calls (finding 15)", async () => {
    const { host, owner, routines } = await routineHost();
    await routines.create(owner, SWEEP);
    const before = host.automations.calls.length;
    await host.server.check.pass();
    expect(host.automations.calls.length).toBe(before);
  });
});

describe("away pause", () => {
  const DAY = 24 * 60 * 60_000;

  /** A Captain seen at 1s with two routines, one paused by hand, and a scheduled run 3 days in. */
  async function awayHost() {
    const base = await routineHost();
    const { host, captainId, owner, routines } = base;
    const sweep = await routines.create(owner, SWEEP);
    const manual = await routines.create(owner, { ...SWEEP, name: "Digest" }, { paused: true });
    host.server.store.setLastSeen(captainId, "web", 1_000);
    host.setNow(1_000 + 3 * DAY);
    await routines.fire(sweep.id, { automationId: sweep.automationId as string, runId: null });
    const enabled = (id: string | null) => host.automations.rows.get(id as string)?.enabled;
    const awayAsks = () =>
      host.server.store
        .asksOf(captainId)
        .filter((ask) => ask.text === "Routines paused while you were away");
    const maintainAt = async (at: number) => {
      host.setNow(at);
      return host.server.routines.maintain();
    };
    const resolve = (askId: string, answer: string, threadId?: string) =>
      host.harness.behavior.runCli(
        ["ask", "resolve", askId, "--answer", answer],
        threadId === undefined ? {} : { threadId },
      );
    return { ...base, sweep, manual, enabled, awayAsks, maintainAt, resolve };
  }

  test("after 7 days unseen, maintenance pauses running routines and opens one ask", async () => {
    const { host, sweep, manual, enabled, awayAsks, maintainAt } = await awayHost();
    await maintainAt(1_000 + 6 * DAY);
    expect(awayAsks()).toEqual([]);

    await maintainAt(1_000 + 7 * DAY + 60_000);
    expect(enabled(sweep.automationId)).toBe(false);
    const [ask] = awayAsks();
    expect(ask).toMatchObject({
      kind: "decision",
      taskKey: null,
      options: ["Resume", "Keep paused"],
    });
    expect(ask?.options.every((option) => option.length <= 12)).toBe(true);
    expect(ask?.detail).toContain('r1 "Stalled crew sweep"');
    expect(ask?.detail).not.toContain("Digest");
    expect(host.server.store.awayHolds({ askId: ask?.id }).map((h) => h.routineId)).toEqual([
      sweep.id,
    ]);
    expect(enabled(manual.automationId)).toBe(false);
  });

  test("a second pass, or a reload, opens no second ask", async () => {
    const { host, awayAsks, maintainAt } = await awayHost();
    await maintainAt(1_000 + 8 * DAY);
    await maintainAt(1_000 + 8 * DAY + 120_000);
    await host.reload();
    await maintainAt(1_000 + 9 * DAY);
    expect(awayAsks()).toHaveLength(1);
  });

  test("an outage during the pause is retried, not lost (finding 1)", async () => {
    const { host, sweep, enabled, awayAsks, maintainAt } = await awayHost();
    host.automations.down = true;
    await maintainAt(1_000 + 8 * DAY);
    expect(awayAsks()).toEqual([]);
    host.automations.down = false;
    // The pause itself fails once after the choice was recorded.
    host.automations.failNext.add("automations_pause");
    await maintainAt(1_000 + 8 * DAY + 60_000);
    expect(enabled(sweep.automationId)).toBe(true);
    expect(awayAsks()).toEqual([]);
    expect((await maintainAt(1_000 + 8 * DAY + 120_000)).pending).toBe(false);
    expect(enabled(sweep.automationId)).toBe(false);
    expect(awayAsks()).toHaveLength(1);
  });

  test("trimming the run history keeps the delivery that qualifies (finding 2)", async () => {
    const { host, captainId, sweep, awayAsks, maintainAt } = await awayHost();
    // Twenty skips while the delivered run waits push it out of the 20-row history.
    host.queued.set(captainId, [queued('[captain] routine r1 "Stalled crew sweep" · scheduled')]);
    for (let i = 0; i < 20; i += 1) {
      await host.server.routines.fire(sweep.id, {
        automationId: sweep.automationId as string,
        runId: null,
      });
    }
    expect(host.server.store.routineRuns(sweep.id).every((run) => run.status === "skipped")).toBe(
      true,
    );
    await maintainAt(1_000 + 8 * DAY);
    expect(awayAsks()).toHaveLength(1);
  });

  test("holds chosen before the user came back are still finished", async () => {
    const { host, captainId, sweep, enabled, awayAsks, maintainAt } = await awayHost();
    host.automations.failNext.add("automations_pause");
    await maintainAt(1_000 + 8 * DAY);
    expect(host.server.store.awayHolds({ captainId })).toMatchObject([{ paused: false }]);
    // The user opens the Captain before the retry: the chosen pause still completes, with its ask.
    host.server.store.setLastSeen(captainId, "web", 1_000 + 8 * DAY + 1);
    expect((await maintainAt(1_000 + 8 * DAY + 60_000)).pending).toBe(false);
    expect(enabled(sweep.automationId)).toBe(false);
    expect(awayAsks()).toHaveLength(1);
  });

  test("an archived Captain's holds are released", async () => {
    const { host, captainId, awayAsks, maintainAt } = await awayHost();
    host.automations.failNext.add("automations_pause");
    await maintainAt(1_000 + 8 * DAY);
    host.server.store.archiveCaptain(captainId, 1_000 + 8 * DAY);
    await maintainAt(1_000 + 8 * DAY + 60_000);
    expect(host.server.store.awayHolds()).toEqual([]);
    expect(awayAsks()).toEqual([]);
  });

  test("no run since the user was last seen: nothing is paused", async () => {
    const { host, captainId, sweep, enabled, awayAsks, maintainAt } = await awayHost();
    host.server.store.setLastSeen(captainId, "web", 1_000 + 4 * DAY);
    await maintainAt(1_000 + 12 * DAY);
    expect(awayAsks()).toEqual([]);
    expect(enabled(sweep.automationId)).toBe(true);
  });

  test("reconcile keeps a held routine paused when it remakes its automation (finding 5)", async () => {
    const { host, sweep, awayAsks, maintainAt } = await awayHost();
    await maintainAt(1_000 + 8 * DAY);
    expect(awayAsks()).toHaveLength(1);
    host.automations.rows.delete(sweep.automationId as string);
    await host.reload();
    await maintainAt(1_000 + 8 * DAY + 60_000);
    const remade = host.server.store.routine(sweep.id)?.automationId as string;
    expect(remade).not.toBe(sweep.automationId);
    expect(host.automations.rows.get(remade)?.enabled).toBe(false);
  });

  test("Resume resumes exactly the routines it held", async () => {
    const { host, captainId, sweep, manual, enabled, awayAsks, maintainAt, resolve } =
      await awayHost();
    await maintainAt(1_000 + 8 * DAY);
    const [ask] = awayAsks();
    expect((await resolve(ask?.id as string, "Resume")).exitCode).toBe(0);
    expect(enabled(sweep.automationId)).toBe(true);
    expect(enabled(manual.automationId)).toBe(false);
    expect(host.server.store.awayHolds()).toEqual([]);
    expect(host.sent.at(-1)).toMatchObject({ threadId: captainId });
    expect(host.sent.at(-1)?.text).toContain('answered "Resume"');
  });

  test("Keep paused leaves them paused and ends the hold", async () => {
    const { host, sweep, enabled, awayAsks, maintainAt, resolve } = await awayHost();
    await maintainAt(1_000 + 8 * DAY);
    const [ask] = awayAsks();
    await resolve(ask?.id as string, "Keep paused");
    expect(enabled(sweep.automationId)).toBe(false);
    expect(host.server.store.awayHolds()).toEqual([]);
  });

  test("a resume that fails on answer is retried by the next pass", async () => {
    const { host, sweep, enabled, awayAsks, maintainAt, resolve } = await awayHost();
    await maintainAt(1_000 + 8 * DAY);
    const [ask] = awayAsks();
    host.automations.failNext.add("automations_resume");
    expect((await resolve(ask?.id as string, "Resume")).stderr).toContain("not resumed");
    await maintainAt(1_000 + 8 * DAY + 60_000);
    expect(enabled(sweep.automationId)).toBe(true);
    expect(host.server.store.awayHolds()).toEqual([]);
  });

  test("only the user or its own Captain may answer the away ask (finding 7)", async () => {
    const { host, captainId, sweep, enabled, awayAsks, maintainAt, resolve } = await awayHost();
    host.addThread({ id: "thr_crew1", parentThreadId: captainId });
    await maintainAt(1_000 + 8 * DAY);
    const [ask] = awayAsks();
    const refused = await resolve(ask?.id as string, "Resume", "thr_crew1");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("cannot answer it");
    expect(host.server.store.ask(ask?.id as string)?.answer).toBeNull();
    expect(enabled(sweep.automationId)).toBe(false);
    expect((await resolve(ask?.id as string, "Resume", captainId)).exitCode).toBe(0);
    expect(enabled(sweep.automationId)).toBe(true);
  });
});

function queued(text: string) {
  return {
    id: `qm_${text.length}`,
    text,
    state: "queued",
    content: [{ type: "text" as const, text, mentions: [] as [] }],
    waitingOn: { kind: "turn" },
  };
}

async function waitFor(check: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
