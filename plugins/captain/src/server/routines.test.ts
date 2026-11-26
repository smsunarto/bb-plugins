import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROUTINE_INSTRUCTION_MAX,
  ROUTINES_PER_CAPTAIN,
  routineFieldsSchema,
  routinesTag,
} from "../contract/routines.ts";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test } from "vitest";
import { ROUTINE_ENV, ROUTINE_SCRIPT } from "./automations-client.ts";
import { DEFAULT_ROUTINES } from "./default-routines.ts";
import { Refusal } from "./output.ts";
import type { RoutineOwner } from "./routines.ts";
import { captainHost, clearRoutines, deferred, newCaptain, type CaptainHost } from "./test-host.ts";

const SWEEP = {
  name: "Stalled crew sweep",
  instruction: "Run bb captain status --all and nudge stalled crew.",
  schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
};

async function routineHost() {
  return ownerOf(await captainHost());
}

async function ownerOf(host: CaptainHost) {
  const captainId = await newCaptain(host);
  clearRoutines(host, captainId);
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
    expect(send?.text).toContain("end the turn with no text");
    expect(send?.text).not.toContain("reply with that one line");
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

describe("deletes, names and maintenance limits", () => {
  const gate = (host: CaptainHost, methods: string[]) => {
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.automations.gate = { until, methods: new Set(methods) };
    return () => {
      host.automations.gate = null;
      release();
    };
  };
  const creates = (host: CaptainHost) =>
    host.automations.calls.filter((call) => call.method === "automations_create").length;

  test("a delete while Automations is down retires the routine and keeps the delete", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    host.automations.down = true;
    await routines.act(created, "delete");
    expect(host.server.store.routine(created.id)).toBeNull();
    expect(host.server.store.cleanups()).toMatchObject([
      { kind: "delete", automationId: created.automationId, routineId: created.id },
    ]);

    host.automations.down = false;
    const before = creates(host);
    await routines.maintain();
    expect(host.automations.rows.size).toBe(0);
    expect(host.server.store.cleanups()).toEqual([]);
    expect(creates(host)).toBe(before);
  });

  test("a delete retires the routine locally before Automations answers", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const open = gate(host, ["automations_delete"]);
    const deleting = routines.act(created, "delete");
    await waitFor(() => host.automations.inFlight === 1);
    // An interruption here leaves no routine to remake, only the delete to retry.
    expect(host.server.store.routine(created.id)).toBeNull();
    expect(host.server.store.cleanups()).toMatchObject([
      { kind: "delete", automationId: created.automationId, routineId: created.id },
    ]);
    open();
    await deleting;
    expect(host.server.store.cleanups()).toEqual([]);
    expect(host.automations.rows.size).toBe(0);
  });

  test("a pending delete of a routine's automation stops repair from remaking it", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const automationId = created.automationId as string;
    host.server.store.addCleanup(
      { kind: "delete", projectId: owner.homeProjectId, automationId, routineId: created.id },
      "pending",
      1,
    );
    host.automations.rows.delete(automationId);
    const before = creates(host);
    await routines.maintain();
    expect(creates(host)).toBe(before);
  });

  test("a delete retry keeps an automation whose script changed since", async () => {
    const { host, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const row = host.automations.rows.get(created.automationId as string);
    if (row === undefined) throw new Error("no automation");
    host.automations.down = true;
    await routines.act(created, "delete");
    host.automations.down = false;
    row.execution = { ...row.execution, script: "echo someone else's job\n" };
    await routines.maintain();
    expect(host.automations.rows.has(row.id)).toBe(true);
    expect(host.server.store.cleanups()).toEqual([]);
  });

  test("a rename that fails never refuses a create of the same name", async () => {
    const { host, owner, routines } = await routineHost();
    const first = await routines.create(owner, SWEEP);
    const open = gate(host, ["automations_update"]);
    const renaming = routines.update(first, { name: "Digest" });
    await waitFor(() => host.automations.inFlight === 1);
    host.automations.failNext.add("automations_update");
    // Waits for the rename: its reservation must not refuse this create.
    const creating = routines.create(owner, { ...SWEEP, name: "Digest" });
    open();
    await expect(renaming).rejects.toThrow();
    expect((await creating).name).toBe("Digest");
    expect(host.server.store.routine(first.id)?.name).toBe(SWEEP.name);
  });

  test("a create of a name being renamed away waits, so a failed rename restores it", async () => {
    const { host, owner, routines } = await routineHost();
    const first = await routines.create(owner, SWEEP);
    const open = gate(host, ["automations_update"]);
    const renaming = routines.update(first, { name: "Digest" });
    await waitFor(() => host.automations.inFlight === 1);
    host.automations.failNext.add("automations_update");
    const creating = routines.create(owner, SWEEP);
    open();
    await expect(renaming).rejects.toThrow();
    await expect(creating).rejects.toThrow();
    expect(host.server.store.routine(first.id)?.name).toBe(SWEEP.name);
    expect(host.automations.rows.get(first.automationId as string)?.name).toContain(SWEEP.name);
  });

  test("a send past fire's deadline keeps its guard and records its outcome", async () => {
    const host = await captainHost({ threadDeadlineMs: 20 });
    const { captainId, owner, routines } = await ownerOf(host);
    const created = await routines.create(owner, SWEEP);
    const call = { automationId: created.automationId as string, runId: null };
    host.busy.add(captainId);
    let release = () => {};
    host.threadHolds.send = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(routines.fire(created.id, call)).rejects.toThrow(/no answer yet/);
    // The queue is still empty: only the guard stops a second message.
    host.setNow(host.now() + 1_000);
    expect((await routines.fire(created.id, call)).state).toBe("skipped");
    host.threadHolds.send = null;
    release();
    await waitFor(() => host.server.store.routineRuns(created.id).length === 2);
    expect(routineSends(host, captainId)).toHaveLength(1);
    expect(host.queued.get(captainId)).toHaveLength(1);
    expect(
      host.server.store.routineRuns(created.id).map((run) => [run.status, run.reason]),
    ).toEqual([
      ["skipped", "previous delivery in flight"],
      ["queued", null],
    ]);
    expect(host.server.store.routineRuns(created.id, 1)[0]?.at).toBe(host.now());
  });

  test("a reload preserves an outstanding send and records it on the current plugin", async () => {
    const host = await captainHost({ threadDeadlineMs: 20 });
    const { captainId, owner, routines } = await ownerOf(host);
    const created = await routines.create(owner, SWEEP);
    const call = { automationId: created.automationId!, runId: null };
    host.busy.add(captainId);
    const gate = deferred();
    host.threadHolds.send = gate.promise;
    try {
      await expect(routines.fire(created.id, call)).rejects.toThrow(/no answer yet/);
      await host.reload();
      await expect(host.server.routines.fire(created.id, call)).resolves.toMatchObject({
        state: "skipped",
        run: { reason: "previous delivery in flight" },
      });
    } finally {
      gate.resolve();
    }
    await waitFor(() => host.server.store.routineRuns(created.id).length === 2);
    expect(host.queued.get(captainId)).toHaveLength(1);
  });

  test("a send that settles between plugin generations is recorded once on startup", async () => {
    const host = await captainHost({ threadDeadlineMs: 20 });
    const { captainId, owner, routines } = await ownerOf(host);
    const created = await routines.create(owner, SWEEP);
    host.busy.add(captainId);
    const held = deferred();
    host.threadHolds.send = held.promise;
    try {
      await expect(
        routines.fire(created.id, { automationId: created.automationId!, runId: null }),
      ).rejects.toThrow(/no answer yet/);
      await host.reload(async () => {
        held.resolve();
        await waitFor(() => host.queued.get(captainId)?.length === 1);
        // Let the send's completion handler finish before Captain starts again.
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    } finally {
      held.resolve();
    }
    expect(host.server.store.routineRuns(created.id)).toMatchObject([
      { at: host.now(), status: "queued" },
    ]);
    await host.reload();
    expect(host.server.store.routineRuns(created.id)).toHaveLength(1);
    expect(host.queued.get(captainId)).toHaveLength(1);
  });

  test("a disposed lookup cannot clear a replacement generation's send guard", async () => {
    const host = await captainHost({ threadDeadlineMs: 1_000 });
    const { captainId, owner, routines } = await ownerOf(host);
    const created = await routines.create(owner, SWEEP);
    const call = { automationId: created.automationId!, runId: null };
    host.busy.add(captainId);
    const lookup = deferred();
    const send = deferred();
    const before = host.harness.inspection.sdk.callsTo("threads.get").length;
    host.threadHolds.get = lookup.promise;
    const oldFire = routines.fire(created.id, call).catch((error: unknown) => error);
    try {
      await waitFor(() => host.harness.inspection.sdk.callsTo("threads.get").length > before);
      host.threadHolds.get = null;
      await host.reload(async () => {});
      host.threadHolds.send = send.promise;
      const newFire = host.server.routines.fire(created.id, call).catch((error: unknown) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      lookup.resolve();
      const refusal = await oldFire;
      await host.reload();
      expect(await host.server.routines.fire(created.id, call)).toMatchObject({
        state: "skipped",
        run: { reason: "previous delivery in flight" },
      });
      expect(refusal).toBeInstanceOf(Refusal);
      expect(refusal).toMatchObject({ message: expect.stringMatching(/reloaded/u) });
      send.resolve();
      expect(await newFire).toMatchObject({ state: "queued" });
      expect(host.queued.get(captainId)).toHaveLength(1);
      expect(
        host.server.store
          .routineRuns(created.id)
          .map((run) => run.status)
          .sort(),
      ).toEqual(["queued", "skipped"]);
    } finally {
      lookup.resolve();
      send.resolve();
    }
  });

  test.each(["delete", "reschedule"] as const)(
    "settling a late send after %s cannot change the current routine's completion",
    async (mutation) => {
      const host = await captainHost({ threadDeadlineMs: 20 });
      const { captainId, owner, routines } = await ownerOf(host);
      const created = await routines.create(owner, SWEEP);
      const gate = deferred();
      host.threadHolds.send = gate.promise;
      await expect(
        routines.fire(created.id, { automationId: created.automationId!, runId: null }),
      ).rejects.toThrow(/no answer yet/);
      const originalTime = host.now();
      const at = originalTime + 60_000;
      if (mutation === "delete") await routines.act(created, "delete");
      else {
        const updated = await routines.update(created, { schedule: { at } });
        await routines.act(updated, "pause");
      }
      host.setNow(at + 1_000);
      gate.resolve();
      await waitFor(() => routineSends(host, captainId).length === 1);
      if (mutation === "delete") {
        expect(host.server.store.routineRuns(created.id)).toEqual([]);
      } else {
        const current = host.server.store.routine(created.id)!;
        expect((await routines.view(current)).done).toBe(false);
        expect(current).toMatchObject({ firedAt: null, deliveredAt: null });
        expect(host.server.store.routineRuns(created.id)[0]).toMatchObject({ at: originalTime });
      }
    },
  );

  test("a completed wake invalidates the routines tag once", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const created = await routines.create(owner, SWEEP);
    const invalidations = host.harness.inspection.experimental_rpcInvalidations;
    const before = invalidations.length;
    await routines.fire(created.id, { automationId: created.automationId!, runId: null });
    expect(
      invalidations
        .slice(before)
        .flat()
        .filter((tag) => tag === routinesTag(captainId)),
    ).toHaveLength(1);
  });

  test("a queued create cannot escape a native archive", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const open = gate(host, ["automations_create"]);
    const first = routines.create(owner, SWEEP);
    await waitFor(() => host.automations.inFlight === 1);
    const second = routines.create(owner, { ...SWEEP, name: "Digest" });
    host.updateThread(captainId, { archivedAt: 5_000 });
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: captainId, archivedAt: 5_000 }),
    });
    open();
    await first;
    await expect(second).rejects.toThrow(/no longer live/);
    await waitFor(() => [...host.automations.rows.values()].every((row) => !row.enabled));
    expect(host.automations.rows.size).toBe(1);
  });

  test("a Captain lookup that times out is recorded, so a spent one-shot shows missed", async () => {
    const host = await captainHost({ threadDeadlineMs: 20 });
    const { owner, routines } = await ownerOf(host);
    const created = await routines.create(owner, {
      ...SWEEP,
      schedule: { at: host.now() + 60_000 },
    });
    host.setNow(host.now() + 120_000);
    let release = () => {};
    host.threadHolds.get = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(
      routines.fire(created.id, { automationId: created.automationId as string, runId: null }),
    ).rejects.toThrow(/did not answer/);
    host.threadHolds.get = null;
    release();
    // Automations disables a once automation after its run.
    const row = host.automations.rows.get(created.automationId as string);
    if (row !== undefined) row.enabled = false;
    expect(host.server.store.routineRuns(created.id)[0]).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/did not answer reading the Captain/),
    });
    const stored = host.server.store.routine(created.id);
    const view = await routines.view(stored as never);
    expect(view.missed).toBe(true);
    expect(view.lastRun?.reason).toMatch(/did not answer/);
  });

  test("a create queued behind a Captain's deletion is refused", async () => {
    const { host, captainId, owner, routines } = await routineHost();
    const open = gate(host, ["automations_create"]);
    const first = routines.create(owner, SWEEP);
    await waitFor(() => host.automations.inFlight === 1);
    const second = routines.create(owner, { ...SWEEP, name: "Digest" });
    const removing = routines.removeCaptain(captainId);
    open();
    await first;
    await expect(second).rejects.toThrow(/no longer live/);
    await removing;
    expect(host.server.store.routinesOf(captainId)).toEqual([]);
    expect(host.automations.rows.size).toBe(0);
  });

  test("a stopped reconcile reads no further project", async () => {
    const { host, owner, routines } = await routineHost();
    await routines.create(owner, SWEEP);
    host.server.store.addCleanup(
      { kind: "delete", projectId: "proj_rampage", automationId: "auto_x", routineId: "r9" },
      "pending",
      1,
    );
    const open = gate(host, ["automations_list"]);
    const stopping = new AbortController();
    const pass = routines.maintain(stopping.signal);
    await waitFor(() => host.automations.inFlight === 1);
    stopping.abort();
    open();
    await pass;
    const lists = host.automations.calls.filter((c) => c.method === "automations_list");
    expect(lists).toHaveLength(1);
  });

  test("a slow maintenance item keeps its worker slot past the deadline", async () => {
    const host = await captainHost({ maintenanceDeadlineMs: 5 });
    const { owner, routines } = await ownerOf(host);
    for (let i = 0; i < 6; i++) await routines.create(owner, { ...SWEEP, name: `R${i}` });
    host.automations.rows.clear();
    const open = gate(host, ["automations_create"]);
    const pass = routines.maintain();
    await waitFor(() => host.automations.inFlight === 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.automations.inFlight).toBe(4);
    open();
    await pass;
    expect(host.automations.rows.size).toBe(6);
  });

  test("a stopped maintenance pass starts no new work", async () => {
    const { host, owner, routines } = await routineHost();
    for (let i = 0; i < 6; i++) await routines.create(owner, { ...SWEEP, name: `R${i}` });
    const stopped = new AbortController();
    stopped.abort();
    const before = host.automations.calls.length;
    await routines.maintain(stopped.signal);
    expect(host.automations.calls.length).toBe(before);

    host.automations.rows.clear();
    const open = gate(host, ["automations_create"]);
    const stopping = new AbortController();
    const pass = routines.maintain(stopping.signal);
    await waitFor(() => host.automations.inFlight === 4);
    stopping.abort();
    open();
    expect((await pass).pending).toBe(true);
    expect(host.automations.rows.size).toBe(4);
  });
});

describe("default daily routines", () => {
  function seedPreexistingCaptain(host: CaptainHost, threadId: string, name: string) {
    host.addThread({ id: threadId, projectId: "proj_captains", title: name });
    host.server.store.putCaptain({
      threadId,
      name,
      homeProjectId: "proj_captains",
      createdAt: host.now(),
      repos: [{ bbProjectId: "proj_plugins", tasksProjectKey: "BBPLUGINS" }],
    });
  }

  function allSeeded(host: CaptainHost, captainId: string): boolean {
    return DEFAULT_ROUTINES.every((spec) =>
      host.server.store.defaultRoutineSeeded(captainId, spec.key),
    );
  }

  test("backfill seeds all four daily defaults on an existing Captain with no routines", async () => {
    const host = await captainHost({ defaultTimezone: "America/Los_Angeles" });
    seedPreexistingCaptain(host, "thr_existing", "Existing");

    expect(allSeeded(host, "thr_existing")).toBe(false);
    const result = await host.server.routines.backfillDefaults();
    expect(result).toEqual({ complete: true, warnings: [] });
    expect(allSeeded(host, "thr_existing")).toBe(true);

    const routines = host.server.store.routinesOf("thr_existing");
    expect(routines.map((r) => ({ name: r.name, schedule: r.schedule }))).toEqual([
      {
        name: "Backlog grooming",
        schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
      },
      { name: "Drive sweep", schedule: { cron: "30 9 * * *", timezone: "America/Los_Angeles" } },
      {
        name: "Rebase crew work",
        schedule: { cron: "0 10 * * *", timezone: "America/Los_Angeles" },
      },
      {
        name: "Stuck crew cleanup",
        schedule: { cron: "30 10 * * *", timezone: "America/Los_Angeles" },
      },
    ]);
    for (const spec of DEFAULT_ROUTINES) {
      const stored = routines.find((r) => r.name === spec.name);
      expect(stored?.instruction).toBe(host.server.files.read(spec.instructionFile));
    }
    expect(host.automations.rows.size).toBe(4);
    for (const routine of routines) {
      expect(routine.automationId).not.toBeNull();
      expect(host.automations.rows.get(routine.automationId as string)?.enabled).toBe(true);
    }
  });

  test("backfill runs on plugin start/reload for existing Captains", async () => {
    const host = await captainHost({ defaultTimezone: "Europe/Berlin" });
    seedPreexistingCaptain(host, "thr_legacy", "Legacy");

    await host.reload();

    const routines = host.server.store.routinesOf("thr_legacy");
    expect(routines.map((r) => [r.name, r.schedule])).toEqual([
      ["Backlog grooming", { cron: "0 9 * * *", timezone: "Europe/Berlin" }],
      ["Drive sweep", { cron: "30 9 * * *", timezone: "Europe/Berlin" }],
      ["Rebase crew work", { cron: "0 10 * * *", timezone: "Europe/Berlin" }],
      ["Stuck crew cleanup", { cron: "30 10 * * *", timezone: "Europe/Berlin" }],
    ]);
    for (const spec of DEFAULT_ROUTINES) {
      const stored = routines.find((r) => r.name === spec.name);
      expect(stored?.instruction).toBe(host.server.files.read(spec.instructionFile));
    }
    expect(allSeeded(host, "thr_legacy")).toBe(true);
  });

  function defaultSpec(key: string) {
    const spec = DEFAULT_ROUTINES.find((entry) => entry.key === key);
    if (spec === undefined) throw new Error(`missing default routine spec ${key}`);
    return spec;
  }

  test("backfill adds the two new defaults to a Captain already seeded with the first two", async () => {
    const host = await captainHost({ defaultTimezone: "America/New_York" });
    seedPreexistingCaptain(host, "thr_seeded_two", "SeededTwo");
    const owner: RoutineOwner = {
      threadId: "thr_seeded_two",
      name: "SeededTwo",
      homeProjectId: "proj_captains",
    };
    for (const key of ["backlog-grooming", "drive-sweep"]) {
      const spec = defaultSpec(key);
      await host.server.routines.create(owner, {
        name: spec.name,
        instruction: host.server.files.read(spec.instructionFile),
        schedule: { cron: spec.cron, timezone: "America/New_York" },
      });
      host.server.store.markDefaultRoutineSeeded("thr_seeded_two", spec.key, host.now());
    }

    const createsBefore = host.automations.calls.filter(
      (call) => call.method === "automations_create",
    ).length;
    const first = await host.server.routines.backfillDefaults();
    expect(first).toEqual({ complete: true, warnings: [] });
    expect(allSeeded(host, "thr_seeded_two")).toBe(true);
    expect(
      host.automations.calls.filter((call) => call.method === "automations_create").length -
        createsBefore,
    ).toBe(2);
    const routines = host.server.store.routinesOf("thr_seeded_two");
    expect(routines.map((r) => ({ name: r.name, schedule: r.schedule }))).toEqual([
      { name: "Backlog grooming", schedule: { cron: "0 9 * * *", timezone: "America/New_York" } },
      { name: "Drive sweep", schedule: { cron: "30 9 * * *", timezone: "America/New_York" } },
      { name: "Rebase crew work", schedule: { cron: "0 10 * * *", timezone: "America/New_York" } },
      {
        name: "Stuck crew cleanup",
        schedule: { cron: "30 10 * * *", timezone: "America/New_York" },
      },
    ]);
    for (const key of ["rebase-crew-work", "stuck-crew-cleanup"]) {
      const spec = defaultSpec(key);
      expect(routines.find((r) => r.name === spec.name)?.instruction).toBe(
        host.server.files.read(spec.instructionFile),
      );
    }
    expect(host.automations.rows.size).toBe(4);

    const callsBeforeSecond = host.automations.calls.length;
    const second = await host.server.routines.backfillDefaults();
    expect(second).toEqual({ complete: true, warnings: [] });
    expect(host.server.store.routinesOf("thr_seeded_two")).toHaveLength(4);
    expect(host.automations.calls.length).toBe(callsBeforeSecond);
  });

  test("backfill adds only the two new defaults when the user removed an earlier default, and running again adds nothing", async () => {
    const host = await captainHost({ defaultTimezone: "America/Los_Angeles" });
    seedPreexistingCaptain(host, "thr_removed_one", "RemovedOne");
    const owner: RoutineOwner = {
      threadId: "thr_removed_one",
      name: "RemovedOne",
      homeProjectId: "proj_captains",
    };
    // Both BBP-128 defaults were seeded, then the user removed Backlog grooming.
    const driveSweep = defaultSpec("drive-sweep");
    await host.server.routines.create(owner, {
      name: driveSweep.name,
      instruction: host.server.files.read(driveSweep.instructionFile),
      schedule: { cron: driveSweep.cron, timezone: "America/Los_Angeles" },
    });
    host.server.store.markDefaultRoutineSeeded("thr_removed_one", "backlog-grooming", host.now());
    host.server.store.markDefaultRoutineSeeded("thr_removed_one", "drive-sweep", host.now());

    const createsBefore = host.automations.calls.filter(
      (call) => call.method === "automations_create",
    ).length;
    const first = await host.server.routines.backfillDefaults();
    expect(first).toEqual({ complete: true, warnings: [] });
    expect(allSeeded(host, "thr_removed_one")).toBe(true);
    expect(
      host.automations.calls.filter((call) => call.method === "automations_create").length -
        createsBefore,
    ).toBe(2);
    expect(
      host.server.store
        .routinesOf("thr_removed_one")
        .map((r) => ({ name: r.name, schedule: r.schedule })),
    ).toEqual([
      { name: "Drive sweep", schedule: { cron: "30 9 * * *", timezone: "America/Los_Angeles" } },
      {
        name: "Rebase crew work",
        schedule: { cron: "0 10 * * *", timezone: "America/Los_Angeles" },
      },
      {
        name: "Stuck crew cleanup",
        schedule: { cron: "30 10 * * *", timezone: "America/Los_Angeles" },
      },
    ]);
    expect(host.server.store.findRoutine("thr_removed_one", "Backlog grooming")).toBeNull();
    expect(host.automations.rows.size).toBe(3);

    const callsBeforeSecond = host.automations.calls.length;
    const second = await host.server.routines.backfillDefaults();
    expect(second).toEqual({ complete: true, warnings: [] });
    expect(host.server.store.routinesOf("thr_removed_one")).toHaveLength(3);
    expect(host.automations.calls.length).toBe(callsBeforeSecond);
  });

  test("backfill skips a default whose name already exists and running twice adds nothing", async () => {
    const host = await captainHost({ defaultTimezone: "UTC" });
    seedPreexistingCaptain(host, "thr_existing", "Existing");
    const owner: RoutineOwner = {
      threadId: "thr_existing",
      name: "Existing",
      homeProjectId: "proj_captains",
    };
    const custom = await host.server.routines.create(owner, {
      name: "backlog grooming",
      instruction: "My custom grooming routine.",
      schedule: { cron: "0 11 * * 1", timezone: "Europe/London" },
    });

    const first = await host.server.routines.backfillDefaults();
    expect(first).toEqual({ complete: true, warnings: [] });

    const afterFirst = host.server.store.routinesOf("thr_existing");
    expect(afterFirst).toHaveLength(4);
    expect(afterFirst.find((r) => r.id === custom.id)).toMatchObject({
      name: "backlog grooming",
      instruction: "My custom grooming routine.",
      schedule: { cron: "0 11 * * 1", timezone: "Europe/London" },
    });
    expect(afterFirst.find((r) => r.name === "Drive sweep")).toMatchObject({
      schedule: { cron: "30 9 * * *", timezone: "UTC" },
      instruction: host.server.files.read("routines/drive-sweep"),
    });
    expect(afterFirst.find((r) => r.name === "Rebase crew work")).toMatchObject({
      schedule: { cron: "0 10 * * *", timezone: "UTC" },
      instruction: host.server.files.read("routines/rebase-crew-work"),
    });
    expect(afterFirst.find((r) => r.name === "Stuck crew cleanup")).toMatchObject({
      schedule: { cron: "30 10 * * *", timezone: "UTC" },
      instruction: host.server.files.read("routines/stuck-crew-cleanup"),
    });

    const callsBeforeSecond = host.automations.calls.length;
    const second = await host.server.routines.backfillDefaults();
    expect(second).toEqual({ complete: true, warnings: [] });
    expect(host.server.store.routinesOf("thr_existing")).toHaveLength(4);
    expect(host.automations.calls.length).toBe(callsBeforeSecond);
  });

  test("a removed default is not recreated by a later backfill or plugin reload", async () => {
    const host = await captainHost({ defaultTimezone: "UTC" });
    const captainId = await newCaptain(host);
    const grooming = host.server.store.findRoutine(captainId, "Backlog grooming");
    expect(grooming).not.toBeNull();

    await host.server.routines.act(grooming!, "delete");
    expect(host.server.store.routinesOf(captainId).map((r) => r.name)).toEqual([
      "Drive sweep",
      "Rebase crew work",
      "Stuck crew cleanup",
    ]);

    expect(await host.server.routines.backfillDefaults()).toEqual({ complete: true, warnings: [] });
    await host.reload();
    await host.server.routines.maintain();

    expect(host.server.store.routinesOf(captainId).map((r) => r.name)).toEqual([
      "Drive sweep",
      "Rebase crew work",
      "Stuck crew cleanup",
    ]);
    expect(host.server.store.findRoutine(captainId, "Backlog grooming")).toBeNull();
  });

  test("partial failure marks the created default seeded so removing it before retry never brings it back", async () => {
    const host = await captainHost({ defaultTimezone: "UTC" });
    seedPreexistingCaptain(host, "thr_existing", "Existing");
    let creates = 0;
    const origCall = host.automations.call;
    host.automations.call = async (method, input) => {
      if (method === "automations_create" && ++creates === 2) {
        throw new Error("plugin automations is not running");
      }
      return origCall(method, input);
    };

    const first = await host.server.routines.backfillDefaults();
    expect(first.complete).toBe(false);
    expect(first.warnings).toHaveLength(1);
    expect(host.server.store.defaultRoutineSeeded("thr_existing", "backlog-grooming")).toBe(true);
    expect(host.server.store.defaultRoutineSeeded("thr_existing", "drive-sweep")).toBe(false);
    expect(host.server.store.defaultRoutineSeeded("thr_existing", "rebase-crew-work")).toBe(false);
    expect(host.server.store.defaultRoutineSeeded("thr_existing", "stuck-crew-cleanup")).toBe(
      false,
    );
    const grooming = host.server.store.findRoutine("thr_existing", "Backlog grooming");
    expect(grooming).not.toBeNull();

    // User deletes the first default while the remaining defaults are still waiting to retry.
    host.automations.call = origCall;
    await host.server.routines.act(grooming!, "delete");
    expect(host.server.store.routinesOf("thr_existing")).toEqual([]);

    const maintenance = await host.server.routines.maintain();
    expect(maintenance.pending).toBe(false);
    expect(allSeeded(host, "thr_existing")).toBe(true);
    expect(host.server.store.routinesOf("thr_existing").map((r) => r.name)).toEqual([
      "Drive sweep",
      "Rebase crew work",
      "Stuck crew cleanup",
    ]);
    expect(host.automations.rows.size).toBe(3);
  });

  test("seeding stops at the first transient failure, coalesces concurrent backfills, and dedupes warnings", async () => {
    const host = await captainHost({ defaultTimezone: "UTC" });
    seedPreexistingCaptain(host, "thr_existing", "Existing");
    host.automations.down = true;

    const held = deferred();
    host.automations.gate = { until: held.promise, methods: new Set(["automations_create"]) };
    const first = host.server.routines.backfillDefaults();
    const second = host.server.routines.backfillDefaults();
    await waitFor(() => host.automations.inFlight === 1);
    host.automations.gate = null;
    held.resolve();

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual(r2);
    expect(r1.complete).toBe(false);
    // Stopped at the first transient failure instead of attempting the remaining defaults too.
    expect(r1.warnings).toHaveLength(1);
    expect(
      host.automations.calls.filter((call) => call.method === "automations_create"),
    ).toHaveLength(1);

    // A follow-up retry while still down logs no duplicate warning.
    const warningsAfterFirst = host.logs().filter((entry) => entry.level === "warn").length;
    expect(warningsAfterFirst).toBe(1);
    const third = await host.server.routines.backfillDefaults();
    expect(third.complete).toBe(false);
    expect(host.logs().filter((entry) => entry.level === "warn")).toHaveLength(warningsAfterFirst);
  });

  test("backfill caches archived Captains to skip later reads and seeds once unarchived", async () => {
    const host = await captainHost({ defaultTimezone: "UTC" });
    seedPreexistingCaptain(host, "thr_archived", "Archived");
    host.updateThread("thr_archived", { archivedAt: 5_000 });

    expect(await host.server.routines.backfillDefaults()).toEqual({ complete: true, warnings: [] });
    expect(host.server.store.routinesOf("thr_archived")).toEqual([]);
    expect(allSeeded(host, "thr_archived")).toBe(false);

    // Second pass skips the archived Captain without calling threads.get again.
    const readsBefore = host.harness.inspection.sdk.callsTo("threads.get").length;
    expect(await host.server.routines.backfillDefaults()).toEqual({ complete: true, warnings: [] });
    expect(host.harness.inspection.sdk.callsTo("threads.get").length).toBe(readsBefore);

    // Once unarchived, the next backfill seeds all four defaults.
    host.updateThread("thr_archived", { archivedAt: null });
    await host.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "thr_archived", archivedAt: null }),
    });
    expect(await host.server.routines.backfillDefaults()).toEqual({ complete: true, warnings: [] });
    expect(host.server.store.routinesOf("thr_archived").map((r) => r.name)).toEqual([
      "Backlog grooming",
      "Drive sweep",
      "Rebase crew work",
      "Stuck crew cleanup",
    ]);
  });

  test("backfill skips a deleted Captain quietly and stops cleanly at the 20-routine cap", async () => {
    const host = await captainHost({ defaultTimezone: "UTC" });
    // Deleted thread: exists in store, absent in bb.
    host.server.store.putCaptain({
      threadId: "thr_gone",
      name: "Gone",
      homeProjectId: "proj_captains",
      createdAt: host.now(),
      repos: [],
    });
    // Full Captain: already has 20 custom routines.
    seedPreexistingCaptain(host, "thr_full", "Full");
    const fullOwner: RoutineOwner = {
      threadId: "thr_full",
      name: "Full",
      homeProjectId: "proj_captains",
    };
    for (let i = 0; i < ROUTINES_PER_CAPTAIN; i += 1) {
      await host.server.routines.create(fullOwner, { ...SWEEP, name: `Custom ${i}` });
    }

    const result = await host.server.routines.backfillDefaults();
    expect(result.complete).toBe(true);
    expect(result.warnings).toHaveLength(DEFAULT_ROUTINES.length);
    expect(allSeeded(host, "thr_gone")).toBe(true);
    expect(allSeeded(host, "thr_full")).toBe(true);
    expect(host.server.store.routinesOf("thr_gone")).toEqual([]);
    expect(host.server.store.routinesOf("thr_full")).toHaveLength(ROUTINES_PER_CAPTAIN);
  });

  test("default routine prompts are non-empty, under 4000 chars, pass routineFieldsSchema, and use distinct daily crons", async () => {
    const host = await captainHost();
    expect(DEFAULT_ROUTINES.map((spec) => [spec.key, spec.name, spec.cron])).toEqual([
      ["backlog-grooming", "Backlog grooming", "0 9 * * *"],
      ["drive-sweep", "Drive sweep", "30 9 * * *"],
      ["rebase-crew-work", "Rebase crew work", "0 10 * * *"],
      ["stuck-crew-cleanup", "Stuck crew cleanup", "30 10 * * *"],
    ]);
    expect(new Set(DEFAULT_ROUTINES.map((spec) => spec.cron)).size).toBe(DEFAULT_ROUTINES.length);
    for (const spec of DEFAULT_ROUTINES) {
      const instruction = host.server.files.read(spec.instructionFile);
      expect(instruction.length).toBeGreaterThan(0);
      expect(instruction.length).toBeLessThanOrEqual(ROUTINE_INSTRUCTION_MAX);
      expect(instruction).toContain("end the turn with no text");
      expect(
        routineFieldsSchema.safeParse({
          name: spec.name,
          instruction,
          schedule: { cron: spec.cron, timezone: "UTC" },
        }).success,
      ).toBe(true);
    }

    const captainInstructions = host.server.files.read("captain", {
      name: "Plugins",
      drive: "/drive",
    });
    expect(captainInstructions).toContain("end the turn with no text");
    expect(captainInstructions).not.toContain("end the turn with one line at most");
    const routinesSkill = readFileSync(
      join(host.server.files.root, "skills/captain-routines/SKILL.md"),
      "utf8",
    );
    const captainDefaultsParagraph = captainInstructions
      .split("\n")
      .find((line) => line.includes("Every Captain starts with"));
    const skillDefaultsParagraph = /## Built-in defaults\n+([^\n]+)/u.exec(routinesSkill)?.[1];
    expect(captainDefaultsParagraph).toBeDefined();
    expect(skillDefaultsParagraph).toBeDefined();
    for (const paragraph of [captainDefaultsParagraph!, skillDefaultsParagraph!]) {
      for (const spec of DEFAULT_ROUTINES) {
        expect(paragraph).toContain(spec.name);
      }
      expect(paragraph).toMatch(/\b(?:change|edit)\b.*\bremove\b/iu);
      expect(paragraph).toMatch(/\bremoved default\b/iu);
    }
    for (const spec of DEFAULT_ROUTINES) {
      expect(skillDefaultsParagraph!).toContain(spec.cron);
    }
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
