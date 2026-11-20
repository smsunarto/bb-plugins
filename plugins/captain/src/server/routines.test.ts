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
      execution: { mode: "script", env: { [ROUTINE_ENV]: "r99" } },
      runs: [],
    });
    host.setNow(host.now() + 5_000);

    expect(await routines.reconcile()).toBe(true);

    const store = host.server.store;
    expect(host.automations.rows.has("auto_orphan")).toBe(false);
    expect(host.automations.rows.has(kept.automationId as string)).toBe(true);
    const relost = store.routine(lost.id);
    expect(relost?.automationId).not.toBe(lost.automationId);
    expect(host.automations.rows.has(relost?.automationId as string)).toBe(true);
    // The one-shot's time passed while its automation was gone: it is not made again.
    expect(store.routine(past.id)?.automationId).toBeNull();
    expect(host.automations.rows.size).toBe(2);
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
