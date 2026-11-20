import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { describe, expect, onTestFinished, test } from "vitest";
import { ROUTINES_PER_CAPTAIN } from "../contract/routines.ts";
import { Refusal } from "./output.ts";
import plugin from "./server.ts";
import { MIGRATIONS, openStore } from "./store.ts";
import { captainHost, newCaptain } from "./test-host.ts";

test("migrations apply once, a second open changes nothing, and rows survive a reload", async () => {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.server.store.putCrewRole({
    threadId: "thr_crew",
    captainId,
    role: "implement",
    reportDueSince: 1_500,
    contractSent: false,
    rung: 2,
    baseBranch: "crew/x",
  });

  openStore(host.bb);
  const reloaded = await host.harness.lifecycle.reload(plugin);
  // Reloaded outside `host.reload()`, so the test host cannot dispose it: its storage is ours to remove.
  onTestFinished(() => reloaded.harness.lifecycle.dispose());
  const again = openStore(reloaded.bb);

  const db = reloaded.bb.storage.database();
  const applied = db.prepare("SELECT id FROM _bb_migrations ORDER BY id").all() as { id: number }[];
  expect(applied.map((row) => row.id)).toEqual(MIGRATIONS.map((_, index) => index));
  expect(again.captain(captainId)).toMatchObject({
    name: "Plugins",
    archivedAt: null,
    repos: [{ bbProjectId: "proj_plugins", tasksProjectKey: "BBPLUGINS" }],
  });
  expect(again.crewRole("thr_crew")).toEqual({
    threadId: "thr_crew",
    captainId,
    role: "implement",
    reportDueSince: 1_500,
    contractSent: false,
    rung: 2,
    baseBranch: "crew/x",
  });

  // The reloaded plugin rebuilt its registry from data.db: the crew still gets its role.
  const resolved = await reloaded.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: "thr_crew", parentThreadId: captainId } }),
  );
  expect(resolved.instructions).toContain("# Role: Implement");
});

describe("routines", () => {
  const fields = (name: string) => ({
    name,
    instruction: "Sweep the crew",
    schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
  });

  test("create, read, update and delete; ids are never reused", async () => {
    const host = await captainHost();
    const store = host.server.store;
    const one = store.createRoutine({ ...fields("Sweep"), captainId: "thr_a", at: 10 });
    const two = store.createRoutine({ ...fields("Digest"), captainId: "thr_a", at: 11 });
    expect([one.id, two.id]).toEqual(["r1", "r2"]);
    expect(store.routine("R1")).toMatchObject({ name: "Sweep", automationId: null });
    expect(store.findRoutine("thr_a", "digest")?.id).toBe("r2");
    expect(store.findRoutine("thr_b", "digest")).toBeNull();

    const updated = store.updateRoutine("r1", { name: "Sweep crew", automationId: "auto_1" }, 20);
    expect(updated).toMatchObject({ name: "Sweep crew", automationId: "auto_1", updatedAt: 20 });

    store.deleteRoutine("r2");
    expect(store.routine("r2")).toBeNull();
    expect(store.createRoutine({ ...fields("Again"), captainId: "thr_a", at: 12 }).id).toBe("r3");
    expect(store.routinesOf("thr_a").map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  test("names are unique per Captain, case-insensitive", async () => {
    const host = await captainHost();
    const store = host.server.store;
    store.createRoutine({ ...fields("Sweep"), captainId: "thr_a", at: 1 });
    expect(() => store.createRoutine({ ...fields("SWEEP"), captainId: "thr_a", at: 2 })).toThrow(
      Refusal,
    );
    store.createRoutine({ ...fields("Sweep"), captainId: "thr_b", at: 2 });
    const other = store.createRoutine({ ...fields("Other"), captainId: "thr_a", at: 3 });
    expect(() => store.updateRoutine(other.id, { name: "sweep" }, 4)).toThrow(/already named/);
  });

  test("a Captain holds at most 20 routines", async () => {
    const host = await captainHost();
    const store = host.server.store;
    for (let i = 0; i < ROUTINES_PER_CAPTAIN; i += 1) {
      store.createRoutine({ ...fields(`R ${i}`), captainId: "thr_a", at: i });
    }
    expect(() =>
      store.createRoutine({ ...fields("One more"), captainId: "thr_a", at: 99 }),
    ).toThrow(/at most 20 routines/);
  });

  test("runs keep the newest 20 per routine and go with their routine", async () => {
    const host = await captainHost();
    const store = host.server.store;
    const routine = store.createRoutine({ ...fields("Sweep"), captainId: "thr_a", at: 1 });
    for (let at = 1; at <= 25; at += 1) {
      store.recordRoutineRun({
        routineId: routine.id,
        trigger: at === 25 ? "test" : "schedule",
        status: "sent",
        reason: null,
        at,
      });
    }
    const runs = store.routineRuns(routine.id);
    expect(runs).toHaveLength(20);
    expect(runs[0]).toMatchObject({ at: 25, trigger: "test" });
    expect(runs.at(-1)?.at).toBe(6);
    expect(store.routine(routine.id)?.deliveredAt).toBe(24);
    store.deleteRoutine(routine.id);
    expect(store.routineRuns(routine.id)).toEqual([]);
  });

  test("fired and delivered times outlive the trimmed history", async () => {
    const host = await captainHost();
    const store = host.server.store;
    const routine = store.createRoutine({ ...fields("Sweep"), captainId: "thr_a", at: 1 });
    store.recordRoutineRun({
      routineId: routine.id,
      trigger: "schedule",
      status: "sent",
      reason: null,
      at: 5,
    });
    for (let at = 6; at < 40; at += 1) {
      store.recordRoutineRun({
        routineId: routine.id,
        trigger: "schedule",
        status: "skipped",
        reason: null,
        at,
      });
    }
    store.recordRoutineRun({
      routineId: routine.id,
      trigger: "test",
      status: "sent",
      reason: null,
      at: 50,
    });
    expect(store.routineRuns(routine.id).some((run) => run.at === 5)).toBe(false);
    expect(store.routine(routine.id)).toMatchObject({ firedAt: 39, deliveredAt: 5 });
  });

  test("a routine's latest run is an index lookup (finding 19)", async () => {
    const host = await captainHost();
    const db = host.bb.storage.database();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1",
      )
      .all("r1") as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toContain("routine_runs_by_routine");
  });

  test("retiring a routine records its delete in the same write", async () => {
    const host = await captainHost();
    const store = host.server.store;
    const routine = store.createRoutine({ ...fields("Sweep"), captainId: "thr_a", at: 10 });
    const key = store.retireRoutine(routine.id, { projectId: "p", automationId: "auto_1" }, 20);
    expect(store.routine(routine.id)).toBeNull();
    expect(store.cleanups()).toMatchObject([
      { key, kind: "delete", automationId: "auto_1", routineId: routine.id },
    ]);
    expect(store.deletePending(routine.id, "auto_1")).toBe(true);
    expect(store.deletePending(routine.id, "auto_2")).toBe(false);
    const bare = store.createRoutine({ ...fields("Digest"), captainId: "thr_a", at: 30 });
    expect(store.retireRoutine(bare.id, null, 40)).toBeNull();
    expect(store.routine(bare.id)).toBeNull();
  });

  test("test runs are claimed once; cleanup rows keep one per key", async () => {
    const host = await captainHost();
    const store = host.server.store;
    store.addTestRun("arun_1", "r1", 100);
    expect(store.takeTestRun("arun_1", 0)).toBe(true);
    expect(store.takeTestRun("arun_1", 0)).toBe(false);
    store.addCleanup(
      { kind: "delete", projectId: "p", automationId: "auto_1", routineId: "r1" },
      "down",
      1,
    );
    store.addCleanup(
      { kind: "delete", projectId: "p", automationId: "auto_1", routineId: "r1" },
      "still down",
      2,
    );
    expect(store.cleanups()).toMatchObject([
      { kind: "delete", automationId: "auto_1", lastError: "still down" },
    ]);
  });
});
