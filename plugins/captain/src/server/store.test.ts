import { createHash } from "node:crypto";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
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

describe("Captain storage migration histories", () => {
  // Pin the deployed statements and their slots independently of the production order.
  const firstDivergentSlot = 21;
  const answerer =
    "ALTER TABLE asks ADD COLUMN answered_by TEXT CHECK (answered_by IN ('user', 'captain'))";
  const routineRunId = "ALTER TABLE routine_runs ADD COLUMN automation_run_id TEXT";
  const routineRunIndex = `DROP INDEX routine_runs_by_routine;
   CREATE INDEX routine_runs_by_routine ON routine_runs (routine_id, at DESC, id DESC)`;
  const taskOwners = MIGRATIONS[firstDivergentSlot + 3] ?? "";
  const askHead = "ALTER TABLE asks ADD COLUMN head TEXT";
  const askVerdict =
    "ALTER TABLE asks ADD COLUMN verdict TEXT CHECK (verdict IN ('passed', 'skipped'))";
  const mainOrder = [answerer, routineRunId, routineRunIndex, taskOwners, askHead, askVerdict];
  // Live: the routines branch ran at 21-22 before answered_by merged, which took 23.
  const liveOrder = [routineRunId, routineRunIndex, answerer, taskOwners, askHead, askVerdict];

  test("ask head and verdict are the last migrations, after task_owners", () => {
    expect(taskOwners).toMatch(/^CREATE TABLE task_owners \(/u);
    expect(MIGRATIONS.slice(-2)).toEqual([askHead, askVerdict]);
    expect(MIGRATIONS.length).toBe(firstDivergentSlot + mainOrder.length);
  });

  test.each([
    { name: "fresh", deployed: null, expected: mainOrder },
    { name: "main after #238", deployed: [answerer], expected: mainOrder },
    { name: "main before task_owners", deployed: mainOrder.slice(0, 3), expected: mainOrder },
    { name: "main before ask head/verdict", deployed: mainOrder.slice(0, 4), expected: mainOrder },
    { name: "live recovery", deployed: liveOrder.slice(0, 3), expected: liveOrder },
    { name: "live before ask head/verdict", deployed: liveOrder.slice(0, 4), expected: liveOrder },
    {
      name: "routines before recovery",
      deployed: [routineRunId, routineRunIndex],
      expected: liveOrder,
    },
  ])(
    "$name preserves migration slots, asks, routine runs and adoptions, and ends with ask head/verdict",
    ({ deployed, expected }) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "captain" });
      onTestFinished(() => harness.lifecycle.dispose());
      const db = bb.storage.database();
      const ledger = () =>
        db.prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all();
      let before: unknown[] = [];
      if (deployed !== null) {
        bb.storage.migrate(db, [...MIGRATIONS.slice(0, firstDivergentSlot), ...deployed]);
        before = ledger();
        db.exec(`
        INSERT INTO routine_runs (routine_id, trigger, status, at)
        VALUES ('r1', 'test', 'sent', 2);
      `);
        if (deployed.includes(routineRunId)) {
          db.exec("UPDATE routine_runs SET automation_run_id = 'arun_old' WHERE routine_id = 'r1'");
        }
        if (deployed.includes(answerer)) {
          db.exec(`
          INSERT INTO asks (id, captain_id, kind, text, detail, asked_at, answer, answered_by)
          VALUES ('a1', 'thr_captain', 'decision', 'Continue?', '', 1, 'Yes', 'user');
          CREATE TABLE pending_adoptions (
            thread_id TEXT PRIMARY KEY,
            captain_id TEXT NOT NULL,
            task_key TEXT NOT NULL,
            task_id TEXT
          );
          INSERT INTO pending_adoptions VALUES ('thr_old', 'thr_captain', 'BBP-1', 'task_1');
        `);
        }
      }

      const store = openStore(bb);
      const upgraded = ledger();
      expect(upgraded.slice(0, before.length)).toEqual(before);
      expect(upgraded.slice(firstDivergentSlot, firstDivergentSlot + expected.length)).toEqual(
        expected.map((sql, index) => ({
          id: firstDivergentSlot + index,
          statement_hash: createHash("sha256").update(sql).digest("hex"),
        })),
      );
      if (deployed !== null) {
        expect(store.routineRuns("r1")).toMatchObject([{ at: 2, status: "sent" }]);
        if (deployed.includes(routineRunId)) {
          expect(store.routineTestResult("r1", "arun_old")).toMatchObject({
            at: 2,
            status: "sent",
          });
        }
        if (deployed.includes(answerer)) {
          expect(store.ask("a1")).toMatchObject({
            answer: "Yes",
            answeredBy: "user",
            head: null,
            verdict: null,
          });
          expect(store.pendingAdoption("thr_old", "thr_captain")).toEqual({
            taskId: "task_1",
            taskKey: "BBP-1",
          });
        }
      }

      const head = "a".repeat(40);
      const ask = store.openAsk({
        captainId: "thr_captain",
        taskKey: "BBP-2",
        kind: "ship",
        head,
        verdict: "passed",
        text: "Merge BBP-2",
        detail: "",
        options: ["Merge", "Hold"],
        askedAt: 4,
      });
      expect(store.answerAsk(ask.id, "Yes", "captain", 5)).toBe(true);
      const run = store.recordRoutineRun({
        routineId: "r1",
        automationRunId: "arun_new",
        trigger: "test",
        status: "sent",
        reason: null,
        at: 6,
      });
      store.beginAdoption("thr_new", "thr_captain", { key: "BBP-2", id: "task_2" });
      store.recordTaskOwner({
        captainId: "thr_captain",
        taskId: "task_3",
        taskKey: "BBP-3",
        source: "created",
        at: 7,
      });

      const reopened = openStore(bb);
      expect(ledger()).toEqual(upgraded);
      expect(reopened.ask(ask.id)).toMatchObject({
        answer: "Yes",
        answeredBy: "captain",
        head,
        verdict: "passed",
      });
      expect(reopened.routineTestResult("r1", "arun_new")).toEqual(run);
      expect(reopened.pendingAdoption("thr_new", "thr_captain")).toEqual({
        taskId: "task_2",
        taskKey: "BBP-2",
      });
      expect(reopened.ownedTaskIds("thr_captain")).toEqual(new Set(["task_3"]));
    },
  );
});

test("answerAsk records answer and optional delivery atomically only while unanswered", async () => {
  const host = await captainHost();
  const store = host.server.store;
  const open = store.openAsk({
    captainId: "thr_c",
    taskKey: "BBP-1",
    kind: "ship",
    head: "a".repeat(40),
    verdict: "passed",
    text: "Merge BBP-1",
    detail: "Review passed.",
    options: ["Merge", "Hold"],
    askedAt: 1,
  });
  const answered = store.openAsk({
    captainId: "thr_c",
    taskKey: "BBP-1",
    kind: "ship",
    head: "b".repeat(40),
    verdict: "passed",
    text: "Merge BBP-1",
    detail: "Review passed.",
    options: ["Merge", "Hold"],
    askedAt: 2,
  });

  expect(store.answerAsk(open.id, "Superseded", "captain", 10, { delivered: true })).toBe(true);
  expect(store.ask(open.id)).toMatchObject({
    answer: "Superseded",
    answeredBy: "captain",
    answeredAt: 10,
    answerDeliveredAt: 10,
  });

  expect(store.answerAsk(answered.id, "Merge", "user", 20)).toBe(true);
  expect(store.answerAsk(answered.id, "Superseded", "captain", 30, { delivered: true })).toBe(
    false,
  );
  expect(store.ask(answered.id)).toMatchObject({
    answer: "Merge",
    answeredBy: "user",
    answeredAt: 20,
    answerDeliveredAt: null,
  });
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

  test("history retains the newest fire times and breaks ties by ID", async () => {
    const {
      server: { store },
    } = await captainHost();
    const routine = store.createRoutine({ ...fields("Sweep"), captainId: "thr_a", at: 1 });
    const record = (at: number) =>
      store.recordRoutineRun({
        routineId: routine.id,
        trigger: "schedule",
        status: "sent",
        reason: null,
        at,
      });
    for (let at = 10; at < 30; at += 1) record(at);
    const tied = record(29);
    const late = record(9);
    const runs = store.routineRuns(routine.id);
    expect(runs).toHaveLength(20);
    expect(runs[0]?.id).toBe(tied.id);
    expect(runs[1]).toMatchObject({ at: 29, id: tied.id - 1 });
    expect(runs.at(-1)?.at).toBe(11);
    expect(runs.some((run) => run.id === late.id)).toBe(false);
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
        "EXPLAIN QUERY PLAN SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .all("r1") as { detail: string }[];
    const detail = plan.map((row) => row.detail).join(" ");
    expect(detail).toContain("routine_runs_by_routine");
    expect(detail).not.toContain("TEMP B-TREE");
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
