import { describe, expect, test, vi } from "vitest";
import { makeThreadResponse, PluginContextStaleError } from "@get-bb/plugin-sdk/testing";
import {
  asksTag,
  CAPTAINS_TAG,
  captainContract,
  crewTag,
  sinceTag,
  type RoutineRow,
} from "../contract/rpc.ts";
import { routinesTag } from "../contract/routines.ts";
import { ROUTINE_ENV } from "./automations-client.ts";
import { ANSWER_MAX_ATTEMPTS } from "./asks.ts";
import { NOTICE } from "./store.ts";
import { captainHost, clearRoutines, deferred, newCaptain, type CaptainHost } from "./test-host.ts";

type Items = { items: Record<string, unknown>[] };

/** A Captain over bb-plugins with two tasks and one decision ask, a1, on BBPLUGINS-1. */
async function bannerHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.addTask("BBPLUGINS-2", { title: "Fix the sidebar" });
  const as = (argv: string[]) => host.harness.behavior.runCli(argv, { threadId: captainId });
  const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
  const invalidations = () => host.harness.inspection.experimental_rpcInvalidations.flat();
  const ask = await as([
    "ask",
    "Pick the cache backend",
    "--task",
    "BBPLUGINS-1",
    "--option",
    "Redis",
    "--option",
    "SQLite",
    "--detail",
    "Builds re-download deps.",
  ]);
  if (ask.exitCode !== 0) throw new Error(ask.stderr);
  const asks = async () => ((await rpc("asks", { captainId })) as Items).items;
  const crew = async () => ((await rpc("crew", { captainId })) as Items).items;
  return { host, captainId, as, rpc, asks, crew, invalidations };
}

/** Dispatch one Implement thread on a task and return its id. */
async function dispatched(
  as: (argv: string[]) => ReturnType<CaptainHost["harness"]["behavior"]["runCli"]>,
  key: string,
) {
  const result = await as(["dispatch", key, "--role", "Implement", "--json"]);
  if (result.exitCode !== 0) throw new Error(result.stdout);
  return (JSON.parse(result.stdout) as { results: { thread: string }[] }).results[0]?.thread ?? "";
}

describe("the banner's reads", () => {
  test("captains lists the live Captains, and new and archive refresh it", async () => {
    const { host, captainId, rpc, invalidations } = await bannerHost();
    expect(await rpc("captains", {})).toEqual({ ids: [captainId] });
    expect(invalidations()).toContain(CAPTAINS_TAG);
    const before = invalidations().length;
    await host.harness.behavior.runCli(["archive", "--captain", captainId]);
    expect(invalidations().slice(before)).toContain(CAPTAINS_TAG);
    expect(await rpc("captains", {})).toEqual({ ids: [] });
  });

  test("homeProjects lists the live Captains' project once, and archive empties it", async () => {
    const { host, captainId, rpc } = await bannerHost();
    const homeProjectId = host.threads.get(captainId)?.projectId;
    expect(homeProjectId).toBeTruthy();
    expect(await rpc("homeProjects", {})).toEqual({ projectIds: [homeProjectId] });
    await newCaptain(host, ["--name", "Second", "--repo", "bb-plugins"]);
    expect(await rpc("homeProjects", {})).toEqual({ projectIds: [homeProjectId] });
    for (const id of await rpc("captains", {}).then((r) => (r as { ids: string[] }).ids)) {
      await host.harness.behavior.runCli(["archive", "--captain", id]);
    }
    expect(await rpc("homeProjects", {})).toEqual({ projectIds: [] });
  });

  test("asks reads the open asks from data.db, and a CLI ask refreshes it", async () => {
    const { asks, invalidations, captainId } = await bannerHost();
    expect(await asks()).toEqual([
      expect.objectContaining({
        kind: "ask",
        key: "ask:a1",
        askKind: "decision",
        text: "Pick the cache backend",
        options: ["Redis", "SQLite"],
        task: "BBPLUGINS-1",
        answer: null,
      }),
    ]);
    expect(invalidations()).toContain(asksTag(captainId));
  });

  test("asks still read while Tasks is down; crew keeps blocked rows without their task", async () => {
    const { host, as, asks, crew } = await bannerHost();
    const blocked = await dispatched(as, "BBPLUGINS-2");
    host.updateThread(blocked, { status: "idle", hasPendingInteraction: true });
    host.interactions.set(blocked, [
      {
        id: "int_1",
        threadId: blocked,
        status: "pending",
        createdAt: 1_000,
        payload: { kind: "plugin", title: "secrets request: UNITY_TOKEN", data: null },
      },
    ]);
    expect(await crew()).toEqual([
      expect.objectContaining({
        kind: "blocked",
        key: "blocked:int_1",
        threadId: blocked,
        title: "secrets request: UNITY_TOKEN",
        task: "BBPLUGINS-2",
        role: "Implement",
      }),
    ]);
    host.tasks.down = true;
    expect(await asks()).toHaveLength(1);
    expect(await crew()).toEqual([expect.objectContaining({ key: "blocked:int_1", task: null })]);
  });

  test("an errored Captain thread is a health row whose action retries the thread", async () => {
    const { host, captainId, crew } = await bannerHost();
    host.updateThread(captainId, { status: "error", updatedAt: 7_000 });
    expect(await crew()).toEqual([
      expect.objectContaining({
        kind: "health",
        key: NOTICE.captainHealth(captainId, 7_000),
        title: "Captain thread errored",
        action: { kind: "retry-thread", threadId: captainId },
      }),
    ]);
  });
});

describe("answering from the banner", () => {
  test("resolveAsk takes the CLI's path: the answer is posted on the task and sent to the Captain", async () => {
    const { host, captainId, rpc, asks, invalidations } = await bannerHost();
    const before = invalidations().length;
    expect(await rpc("resolveAsk", { askId: "a1", answer: "SQLite" })).toEqual({
      state: "answered",
      warnings: [],
    });
    expect(host.sent.at(-1)).toMatchObject({ threadId: captainId });
    expect(host.sent.at(-1)?.text).toContain('a1 answered "SQLite"');
    expect(host.tasks.comments.at(-1)?.body).toBe("Answered: SQLite (a1)");
    expect(await asks()).toEqual([]);
    expect(invalidations().slice(before)).toContain(asksTag(captainId));
  });

  test("a second, different answer is refused with the CLI's reason", async () => {
    const { rpc } = await bannerHost();
    await rpc("resolveAsk", { askId: "a1", answer: "SQLite" });
    await expect(rpc("resolveAsk", { askId: "a1", answer: "Redis" })).rejects.toThrow(
      /already answered "SQLite"/u,
    );
  });

  test("an answer that is not delivered stays in the queue as sending, then turns into a health row", async () => {
    const { host, captainId, rpc, asks } = await bannerHost();
    host.sendFails.add(captainId);
    const first = (await rpc("resolveAsk", { askId: "a1", answer: "SQLite" })) as {
      state: string;
    };
    expect(first.state).toBe("undelivered");
    expect(await asks()).toEqual([expect.objectContaining({ key: "ask:a1", answer: "SQLite" })]);
    for (let attempt = 1; attempt < ANSWER_MAX_ATTEMPTS; attempt += 1) {
      await rpc("resolveAsk", { askId: "a1", answer: "SQLite" });
    }
    expect(await asks()).toEqual([
      expect.objectContaining({
        kind: "health",
        key: NOTICE.answerHealth("a1"),
        action: { kind: "retry-answer", askId: "a1", answer: "SQLite" },
      }),
    ]);
    // Retry is the same resolve; once the send lands the row leaves the queue.
    host.sendFails.delete(captainId);
    await rpc("resolveAsk", { askId: "a1", answer: "SQLite" });
    expect(await asks()).toEqual([]);
  });
});

describe("Later and Skip", () => {
  test("Later snoozes an ask for an hour; Skip records its place at the back", async () => {
    const { host, captainId, rpc, asks } = await bannerHost();
    expect(await rpc("defer", { captainId, key: "ask:a1", action: "later" })).toEqual({
      snoozedUntil: host.now() + 60 * 60_000,
      skipOrder: null,
    });
    host.setNow(host.now() + 5);
    await rpc("defer", { captainId, key: "ask:a1", action: "skip" });
    expect(await asks()).toEqual([
      expect.objectContaining({ snoozedUntil: 1_000 + 60 * 60_000, skipOrder: host.now() }),
    ]);
  });

  test("a blocked row keeps Later in notices and refreshes the crew read", async () => {
    const { host, captainId, rpc, as, crew, invalidations } = await bannerHost();
    const blocked = await dispatched(as, "BBPLUGINS-2");
    host.updateThread(blocked, { status: "idle", hasPendingInteraction: true });
    host.interactions.set(blocked, [
      {
        id: "int_9",
        threadId: blocked,
        status: "pending",
        createdAt: 1_000,
        payload: { kind: "plugin", title: "Approve", data: null },
      },
    ]);
    const before = invalidations().length;
    await rpc("defer", { captainId, key: "blocked:int_9", action: "later" });
    expect(invalidations().slice(before)).toContain(crewTag(captainId));
    expect(await crew()).toEqual([
      expect.objectContaining({ key: "blocked:int_9", snoozedUntil: host.now() + 60 * 60_000 }),
    ]);
  });

  test("Later may not write the check's own notices", async () => {
    const { captainId, rpc } = await bannerHost();
    await expect(
      rpc("defer", { captainId, key: "stall:thr_x:1", action: "later" }),
    ).rejects.toThrow();
  });
});

describe("Since you left", () => {
  test("nothing before the first visit; then transitions after the cutoff, not current state", async () => {
    const { host, captainId, as, rpc, invalidations } = await bannerHost();
    const crew = await dispatched(as, "BBPLUGINS-1");
    const since = () => rpc("sinceYouLeft", { captainId });
    expect(await since()).toEqual({ cutoff: null, done: [], ready: [], failed: [] });

    host.setNow(10_000);
    const before = invalidations().length;
    expect(await rpc("markSeen", { captainId, client: "c_desk" })).toEqual({ at: 10_000 });
    expect(invalidations().slice(before)).toContain(sinceTag(captainId));

    // After leaving: the task is done, BBPLUGINS-2's review passes, and the crew thread fails.
    host.setNow(20_000);
    const task = host.tasks.tasks.find((entry) => entry.key === "BBPLUGINS-1");
    if (task === undefined) throw new Error("fixture");
    task.status = "done";
    task.updatedAt = new Date(20_000).toISOString();
    host.server.store.noticeFirstSeen(NOTICE.failed(crew), 20_000);
    expect(await since()).toEqual({
      cutoff: 10_000,
      done: [{ task: "BBPLUGINS-1", title: "Render PR images", threadId: null }],
      ready: [],
      failed: [{ task: "BBPLUGINS-1", title: "Render PR images", threadId: crew }],
    });

    // Mark seen moves the cutoff past them.
    host.setNow(30_000);
    await rpc("markSeen", { captainId, client: "c_desk" });
    expect(await since()).toMatchObject({ cutoff: 30_000, done: [], failed: [] });
  });
});

describe("watching", () => {
  test("while watched, a crew thread's new interaction refreshes the crew read; unwatched, nothing does", async () => {
    const { host, captainId, as, invalidations } = await bannerHost();
    const blocked = await dispatched(as, "BBPLUGINS-2");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const stop = host.harness.behavior.experimental_watchRpc("crew", { input: { captainId } });
    await settle();
    const before = invalidations().length;
    // An interaction raises no thread event: only the watch sees it.
    host.updateThread(blocked, { hasPendingInteraction: true });
    await settle();
    expect(invalidations().slice(before)).toContain(crewTag(captainId));
    stop();
    await settle();
    const after = invalidations().length;
    host.updateThread(blocked, { hasPendingInteraction: false });
    await settle();
    expect(invalidations().length).toBe(after);
  });
});

describe("the sidebar's Needs you count", () => {
  test("needsYou counts each live Captain's banner items in one call, and 0 for other threads", async () => {
    const { host, captainId, as, rpc } = await bannerHost();
    const quiet = await newCaptain(host, ["--name", "Rampage", "--repo", "rampage"]);
    const blocked = await dispatched(as, "BBPLUGINS-2");
    host.updateThread(blocked, { status: "idle", hasPendingInteraction: true });
    host.interactions.set(blocked, [
      {
        id: "int_2",
        threadId: blocked,
        status: "pending",
        createdAt: 1_000,
        payload: { kind: "plugin", title: "Approve", data: null },
      },
    ]);
    // One open ask and one crew thread paused on an interaction: the banner's "1 of 2".
    expect(await rpc("needsYou", { keys: [captainId, quiet, blocked, "thr_other"] })).toEqual({
      [captainId]: 2,
      [quiet]: 0,
      [blocked]: 0,
      thr_other: 0,
    });
    await rpc("resolveAsk", { askId: "a1", answer: "SQLite" });
    expect(await rpc("needsYou", { keys: [captainId] })).toEqual({ [captainId]: 1 });
  });

  test("an answer still sending counts, as the banner keeps it in the queue", async () => {
    const { host, captainId, rpc } = await bannerHost();
    host.sendFails.add(captainId);
    await rpc("resolveAsk", { askId: "a1", answer: "SQLite" });
    expect(await rpc("needsYou", { keys: [captainId] })).toEqual({ [captainId]: 1 });
  });

  test("a health row counts, and the count holds while Tasks is down", async () => {
    const { host, captainId, rpc } = await bannerHost();
    host.updateThread(captainId, { status: "error", updatedAt: 7_000 });
    expect(await rpc("needsYou", { keys: [captainId] })).toEqual({ [captainId]: 2 });
    host.tasks.down = true;
    // Tasks only names the crew rows' tasks; the health row still reads from bb.
    expect(await rpc("needsYou", { keys: [captainId] })).toEqual({ [captainId]: 2 });
  });

  test("each row refreshes with its Captain's banner reads", () => {
    expect(captainContract.needsYou.keyTags?.("thr_c1", 0)).toEqual([
      asksTag("thr_c1"),
      crewTag("thr_c1"),
    ]);
  });

  test("a crew thread's new interaction refreshes its Captain's crew read", async () => {
    const { host, captainId, as, invalidations } = await bannerHost();
    const blocked = await dispatched(as, "BBPLUGINS-2");
    const before = invalidations().length;
    await host.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({ id: blocked, parentThreadId: captainId }),
      interaction: {} as never,
    });
    expect(invalidations().slice(before)).toContain(crewTag(captainId));
  });
});

describe("New Captain from the app", () => {
  test("newCaptain starts a Captain as `bb captain new` does and lists it", async () => {
    const host = await captainHost();
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
    const started = (await rpc("newCaptain", { name: " Plugins ", repos: ["proj_plugins"] })) as {
      ok: true;
      threadId: string;
      state: string;
    };
    expect(started).toMatchObject({ ok: true, state: "started", warnings: [] });
    expect(await rpc("captains", {})).toEqual({ ids: [started.threadId] });
    expect(host.threads.get(started.threadId)?.title).toBe("Plugins");
    // The same name converges on the live Captain rather than starting a second.
    expect(await rpc("newCaptain", { name: "plugins", repos: ["rampage"] })).toMatchObject({
      ok: true,
      threadId: started.threadId,
      state: "exists",
    });
  });

  test("a refusal names every blocker and starts nothing", async () => {
    const host = await captainHost();
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
    expect(await rpc("newCaptain", { name: "  ", repos: [] })).toEqual({
      ok: false,
      blockers: [
        expect.objectContaining({ reason: "a Captain name is one line of 1 to 80 characters" }),
        expect.objectContaining({ reason: "a Captain directs at least one repo" }),
      ],
    });
    expect(await rpc("newCaptain", { name: "Plugins", repos: ["proj_gone"] })).toEqual({
      ok: false,
      blockers: [expect.objectContaining({ reason: 'no bb project is "proj_gone"' })],
    });
    expect(await rpc("captains", {})).toEqual({ ids: [] });
  });
});

describe("the Overview's routines", () => {
  const SWEEP = {
    name: "Stalled crew sweep",
    instruction: "Nudge stalled crew.",
    schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
  };
  async function routinesHost() {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    clearRoutines(host, captainId);
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
    const list = async () =>
      (
        (await rpc("routines", { captainId })) as {
          routines: RoutineRow[];
          serverTimezone: string;
        }
      ).routines;
    const save = (routine: unknown, routineId?: string) =>
      rpc("saveRoutine", {
        captainId,
        routine,
        ...(routineId === undefined ? {} : { routineId }),
      }) as Promise<{
        ok: boolean;
        routine?: { id: string; updatedAt: number };
        blockers?: { reason: string }[];
      }>;
    return { host, captainId, rpc, list, save };
  }

  test("saveRoutine creates, then lists it with its schedule in words and live state", async () => {
    const { list, save, host } = await routinesHost();
    const saved = await save(SWEEP);
    expect(saved).toMatchObject({ ok: true, routine: { id: "r1", name: SWEEP.name } });
    expect(await list()).toEqual([
      expect.objectContaining({
        id: "r1",
        when: "Every weekday at 9:00 AM",
        automation: expect.objectContaining({ enabled: true }),
      }),
    ]);
    expect(host.automations.rows.size).toBe(1);
  });

  test("a refused save lists the reasons in words and stores nothing", async () => {
    const { list, save } = await routinesHost();
    await save(SWEEP);
    const duplicate = await save({ ...SWEEP, name: "stalled crew SWEEP" });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.blockers?.[0]?.reason).toMatch(/r1 is already named/);
    const frequent = await save({
      ...SWEEP,
      name: "Too often",
      schedule: { cron: "*/5 * * * *", timezone: "UTC" },
    });
    expect(frequent.blockers?.[0]?.reason).toMatch(/at most every 15 minutes/);
    const zone = await save({
      ...SWEEP,
      name: "Bad zone",
      schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" },
    });
    expect(zone.blockers?.[0]?.reason).toMatch(/unknown time zone/);
    expect((await list()).map((routine) => routine.id)).toEqual(["r1"]);
  });

  test("an edit sends only what changed, so a spent one-shot stays renameable", async () => {
    const { host, list, save } = await routinesHost();
    const at = host.now() + 60_000;
    await save({ ...SWEEP, schedule: { at } });
    host.setNow(host.now() + 120_000);
    const renamed = await save({ ...SWEEP, name: "Renamed", schedule: { at } }, "r1");
    expect(renamed.ok).toBe(true);
    expect((await list())[0]?.name).toBe("Renamed");
    // A changed schedule in the past is still refused.
    const past = await save({ ...SWEEP, schedule: { at: at - 1 } }, "r1");
    expect(past.blockers?.[0]?.reason).toMatch(/time has passed/);
  });

  test("an update moves the cron and the time zone together", async () => {
    const { host, save } = await routinesHost();
    await save(SWEEP);
    await save({ ...SWEEP, schedule: { cron: "0 16 * * 5", timezone: "Europe/Berlin" } }, "r1");
    expect([...host.automations.rows.values()][0]?.trigger).toMatchObject({
      cron: "0 16 * * 5",
      timezone: "Europe/Berlin",
    });
  });

  test("routineAction pauses, resumes, tests and deletes; routineRuns returns the test run", async () => {
    const { host, captainId, rpc, list, save } = await routinesHost();
    await save(SWEEP);
    await rpc("routineAction", { captainId, routineId: "r1", action: "pause" });
    expect((await list())[0]?.automation).toMatchObject({ enabled: false });
    await rpc("routineAction", { captainId, routineId: "r1", action: "resume" });
    expect((await list())[0]?.automation).toMatchObject({ enabled: true });
    host.automations.onRun = async (row, runId) => {
      await host.server.routines.fire(row.execution.env?.[ROUTINE_ENV] as string, {
        automationId: row.id,
        runId,
      });
    };
    const test = (await rpc("routineAction", { captainId, routineId: "r1", action: "run" })) as {
      runId: string | null;
      requestedAt: number;
    };
    expect(test).toEqual({ runId: expect.stringMatching(/^arun_/u), requestedAt: host.now() });
    const runs = async () =>
      ((await rpc("routineRuns", { captainId, routineId: "r1" })) as { runs: unknown[] }).runs;
    await vi.waitFor(async () => expect(await runs()).toHaveLength(1));
    expect(await runs()).toEqual([
      expect.objectContaining({
        routineId: "r1",
        trigger: "test",
        status: "sent",
        automationRunId: test.runId,
      }),
    ]);
    expect(await rpc("routineRun", { captainId, routineId: "r1", runId: test.runId })).toEqual({
      run: (await runs())[0],
    });
    expect(await rpc("routineRun", { captainId, routineId: "r1", runId: "arun_missing" })).toEqual({
      run: null,
    });
    await rpc("routineAction", { captainId, routineId: "r1", action: "delete" });
    expect(await list()).toEqual([]);
    expect(host.automations.rows.size).toBe(0);
  });

  test("a save from a stale revision is refused and changes nothing", async () => {
    const { host, captainId, list, save, rpc } = await routinesHost();
    const created = (await save(SWEEP)) as unknown as { routine: { updatedAt: number } };
    const opened = created.routine.updatedAt;
    host.setNow(host.now() + 1_000);
    // Another client changes the cron.
    const moved = (await rpc("saveRoutine", {
      captainId,
      routineId: "r1",
      updatedAt: opened,
      routine: { ...SWEEP, schedule: { cron: "0 16 * * 5", timezone: "UTC" } },
    })) as { ok: boolean };
    expect(moved.ok).toBe(true);
    // This client still holds the original cron and renames.
    const stale = await rpc("saveRoutine", {
      captainId,
      routineId: "r1",
      updatedAt: opened,
      routine: { ...SWEEP, name: "Renamed" },
    });
    expect(stale).toMatchObject({ ok: false, stale: true });
    expect((await list())[0]).toMatchObject({
      name: SWEEP.name,
      schedule: { cron: "0 16 * * 5", timezone: "UTC" },
    });
  });

  test("overlapping cron saves at the same revision cannot both succeed", async () => {
    const { host, captainId, rpc, save } = await routinesHost();
    const created = await save(SWEEP);
    if (!created.ok || created.routine === undefined) throw new Error("create refused");
    const updatedAt = created.routine.updatedAt;
    const firstUpdate = deferred();
    host.automations.gate = {
      until: firstUpdate.promise,
      methods: new Set(["automations_update"]),
    };
    const edit = (cron: string) =>
      rpc("saveRoutine", {
        captainId,
        routineId: "r1",
        updatedAt,
        routine: { ...SWEEP, schedule: { cron, timezone: "UTC" } },
      });
    const first = edit("0 16 * * 5");
    await vi.waitFor(() => expect(host.automations.inFlight).toBe(1));
    const second = edit("0 18 * * 5");
    host.automations.gate = null;
    firstUpdate.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: false, stale: true });
    expect([...host.automations.rows.values()][0]?.trigger).toMatchObject({ cron: "0 16 * * 5" });
  });

  test("a queued rename uses the committed name after a failed reservation rolls back", async () => {
    const { host, captainId, rpc, save } = await routinesHost();
    const created = await save(SWEEP);
    if (!created.ok || created.routine === undefined) throw new Error("create refused");
    const updatedAt = created.routine.updatedAt;
    const held = deferred();
    host.automations.gate = { until: held.promise, methods: new Set(["automations_update"]) };
    host.automations.failNext.add("automations_update");
    const rename = () =>
      rpc("saveRoutine", {
        captainId,
        routineId: "r1",
        updatedAt,
        routine: { ...SWEEP, name: "Renamed" },
      });
    const first = rename();
    await vi.waitFor(() => expect(host.automations.inFlight).toBe(1));
    expect(host.server.store.routine("r1")?.name).toBe("Renamed");
    const second = rename();
    await new Promise<void>((resolve) => setImmediate(resolve));
    host.automations.gate = null;
    held.resolve();
    await expect(first).resolves.toMatchObject({ ok: false, stale: false });
    await expect(second).resolves.toMatchObject({ ok: true, routine: { name: "Renamed" } });
    expect([...host.automations.rows.values()][0]?.name).toContain("Renamed");
  });

  test("a cold Active sample cannot publish after a successful CLI pause", async () => {
    const { host, captainId, list } = await routinesHost();
    const captain = host.server.store.captain(captainId)!;
    await host.server.routines.create(captain, SWEEP);
    const old = deferred();
    const followup = deferred();
    let reads = 0;
    const call = host.automations.call;
    host.automations.call = async (method, input) => {
      const read = method === "automations_get" ? ++reads : 0;
      const result = await call(method, input);
      if (read === 1) await old.promise;
      if (read >= 3) await followup.promise;
      return result;
    };
    try {
      expect((await list())[0]?.scheduleLoading).toBe(true);
      const pause = await host.harness.behavior.runCli(["routine", "pause", "r1"], {
        threadId: captainId,
      });
      expect(pause.exitCode).toBe(0);
      expect([...host.automations.rows.values()][0]?.enabled).toBe(false);
      await list();
      old.resolve();
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
      expect((await list())[0]?.automation?.enabled).not.toBe(true);
      followup.resolve();
      await vi.waitFor(async () => expect((await list())[0]?.automation?.enabled).toBe(false));
    } finally {
      old.resolve();
      followup.resolve();
    }
  });

  test("a delayed Active read cannot overwrite a newer pause", async () => {
    const { host, captainId, list, rpc, save } = await routinesHost();
    await save(SWEEP);
    const old = deferred();
    const followup = deferred();
    let reads = 0;
    const call = host.automations.call;
    host.automations.call = async (method, input) => {
      const read = method === "automations_get" ? ++reads : 0;
      const result = await call(method, input);
      if (read === 1) await old.promise;
      if (read >= 3) await followup.promise;
      return result;
    };
    await list();
    await vi.waitFor(() => expect(reads).toBe(1));
    try {
      await rpc("routineAction", { captainId, routineId: "r1", action: "pause" });
      expect((await list())[0]?.automation?.enabled).toBe(false);
      old.resolve();
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
      expect((await list())[0]?.automation?.enabled).toBe(false);
    } finally {
      old.resolve();
      followup.resolve();
    }
  });

  test("a cold load of twenty schedules publishes one routines tag", async () => {
    const { host, captainId, list } = await routinesHost();
    const owner = host.server.store.captain(captainId)!;
    for (let index = 0; index < 20; index += 1)
      await host.server.routines.create(owner, { ...SWEEP, name: `Sweep ${index}` });
    const held = deferred();
    host.automations.gate = { until: held.promise };
    const invalidations = host.harness.inspection.experimental_rpcInvalidations;
    const before = invalidations.length;
    expect((await list()).every((row) => row.scheduleLoading)).toBe(true);
    host.automations.gate = null;
    held.resolve();
    await vi.waitFor(() => expect(invalidations.length).toBeGreaterThan(before));
    expect(
      invalidations
        .slice(before)
        .flat()
        .filter((tag) => tag === routinesTag(captainId)),
    ).toHaveLength(1);
    expect((await list()).every((row) => !row.scheduleLoading)).toBe(true);
  });

  test("a routine of another Captain is refused", async () => {
    const { host, captainId, rpc, save } = await routinesHost();
    await save(SWEEP);
    const other = await newCaptain(host, ["--name", "Rampage", "--repo", "rampage"]);
    await expect(
      rpc("routineAction", { captainId: other, routineId: "r1", action: "delete" }),
    ).rejects.toThrow(/has no routine r1/);
    await expect(rpc("routineRuns", { captainId: other, routineId: "r1" })).rejects.toThrow(
      /has no routine r1/,
    );
    expect(host.server.store.routinesOf(captainId)).toHaveLength(1);
  });

  test("the list answers from data.db at once, then refreshes with the live schedule", async () => {
    const { host, captainId, list } = await routinesHost();
    // Made by the CLI: the list has read nothing from Automations for it yet.
    const captain = host.server.store.captain(captainId)!;
    await host.server.routines.create(captain, SWEEP);
    let release = () => {};
    host.automations.gate = { until: new Promise<void>((resolve) => (release = resolve)) };
    const before = host.harness.inspection.experimental_rpcInvalidations.length;
    const rows = await list();
    expect(rows[0]).toMatchObject({
      name: SWEEP.name,
      when: "Every weekday at 9:00 AM",
      automation: null,
      scheduleLoading: true,
    });
    host.automations.gate = null;
    release();
    await vi.waitFor(() =>
      expect(host.harness.inspection.experimental_rpcInvalidations.slice(before).flat()).toContain(
        routinesTag(captainId),
      ),
    );
    expect((await list())[0]).toMatchObject({
      scheduleLoading: false,
      automation: expect.objectContaining({ enabled: true }),
    });
  });

  test("each row's live schedule is published as it arrives; a slow one holds back none", async () => {
    const { host, captainId, list } = await routinesHost();
    const captain = host.server.store.captain(captainId)!;
    await host.server.routines.create(captain, SWEEP);
    const slow = await host.server.routines.create(captain, { ...SWEEP, name: "Digest" });
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    // Hold only the Digest routine's lookup.
    const call = host.automations.call;
    host.automations.call = async (method, input) => {
      if (method === "automations_get" && input["automationId"] === slow.automationId) await held;
      return call(method, input);
    };
    const invalidations = host.harness.inspection.experimental_rpcInvalidations;
    const before = invalidations.length;
    await list();
    await vi.waitFor(() =>
      expect(invalidations.slice(before).flat()).toContain(routinesTag(captainId)),
    );
    await vi.waitFor(async () =>
      expect((await list()).map((row) => [row.name, row.scheduleLoading])).toEqual([
        [SWEEP.name, false],
        ["Digest", true],
      ]),
    );
    release();
    await vi.waitFor(async () =>
      expect((await list()).every((row) => !row.scheduleLoading)).toBe(true),
    );
  });

  test("an unchanged schedule refresh performs no per-routine revision lookups", async () => {
    const { host, save, list } = await routinesHost();
    for (let index = 0; index < 20; index += 1)
      expect((await save({ ...SWEEP, name: `Sweep ${index}` })).ok).toBe(true);
    const lookups = vi.spyOn(host.server.store, "routine");
    const before = host.automations.calls.length;
    expect((await list()).every((row) => !row.scheduleLoading)).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      host.automations.calls.slice(before).filter((call) => call.method === "automations_get"),
    ).toHaveLength(20);
    expect(lookups).not.toHaveBeenCalled();
  });

  test("a write that changes the cached schedule publishes the list again", async () => {
    const { host, captainId, rpc, save } = await routinesHost();
    await save(SWEEP);
    const before = host.harness.inspection.experimental_rpcInvalidations.length;
    // The service publishes before the RPC caches its result; the cache change publishes too.
    await rpc("routineAction", { captainId, routineId: "r1", action: "pause" });
    const tags = host.harness.inspection.experimental_rpcInvalidations.slice(before);
    expect(
      tags.filter((each) => each?.includes(routinesTag(captainId))).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("with Automations down, a row says its schedule is unavailable", async () => {
    const { host, captainId, list, save, rpc } = await routinesHost();
    await save(SWEEP);
    host.automations.down = true;
    await rpc("routineAction", { captainId, routineId: "r1", action: "pause" }).catch(() => null);
    await list();
    await vi.waitFor(async () =>
      expect((await list())[0]).toMatchObject({
        name: SWEEP.name,
        automation: null,
        automationError: expect.stringMatching(/^Schedule unavailable/u),
        scheduleLoading: false,
      }),
    );
  });
});

describe("crewRoster", () => {
  test("returns Captain identity and live crew sorted by attention priority, excluding archived crew", async () => {
    const { host, captainId, as, rpc } = await bannerHost();
    host.addTask("BBPLUGINS-3", { title: "Audit permissions" });
    host.addTask("BBPLUGINS-4", { title: "Clean up logs" });
    host.addTask("BBPLUGINS-5", { title: "Old archived task" });

    const idleCrew = await dispatched(as, "BBPLUGINS-1");
    const workingCrew = await dispatched(as, "BBPLUGINS-2");
    const erroredCrew = await dispatched(as, "BBPLUGINS-3");
    const blockedCrew = await dispatched(as, "BBPLUGINS-4");
    const archivedCrew = await dispatched(as, "BBPLUGINS-5");

    host.updateThread(idleCrew, { status: "idle", updatedAt: 5_000 });
    host.updateThread(workingCrew, { status: "active", updatedAt: 4_000 });
    host.updateThread(erroredCrew, { status: "error", updatedAt: 3_000 });
    host.updateThread(blockedCrew, {
      status: "idle",
      hasPendingInteraction: true,
      updatedAt: 2_000,
    });
    host.updateThread(archivedCrew, { status: "idle", archivedAt: 6_000, updatedAt: 6_000 });

    await rpc("setIcon", { captainId, icon: { kind: "icon", name: "Star" } });

    const roster = (await rpc("crewRoster", { captainId })) as {
      captain: { threadId: string; name: string; icon: unknown };
      members: {
        threadId: string;
        title: string;
        role: string | null;
        task: string | null;
        taskTitle: string | null;
        state: string;
      }[];
    };

    expect(roster.captain).toEqual({
      threadId: captainId,
      name: "Plugins",
      icon: { kind: "icon", name: "Star" },
    });
    expect(
      roster.members.map((member) => [member.threadId, member.state, member.task, member.role]),
    ).toEqual([
      [blockedCrew, "needs-input", "BBPLUGINS-4", "Implement"],
      [erroredCrew, "errored", "BBPLUGINS-3", "Implement"],
      [workingCrew, "working", "BBPLUGINS-2", "Implement"],
      [idleCrew, "idle", "BBPLUGINS-1", "Implement"],
    ]);
  });

  test("degrades gracefully when Tasks is down and rejects non-Captain ids", async () => {
    const { host, captainId, as, rpc } = await bannerHost();
    const crewId = await dispatched(as, "BBPLUGINS-1");
    host.updateThread(crewId, { status: "active", updatedAt: 5_000 });
    host.tasks.down = true;

    const roster = (await rpc("crewRoster", { captainId })) as {
      members: { threadId: string; role: string | null; task: string | null; state: string }[];
    };
    expect(roster.members).toEqual([
      expect.objectContaining({
        threadId: crewId,
        role: "Implement",
        task: null,
        state: "working",
      }),
    ]);

    await expect(rpc("crewRoster", { captainId: crewId })).rejects.toThrow(/not a live Captain/u);
  });

  test("shares the in-flight crew read when called concurrently with crew", async () => {
    const { host, captainId, as, rpc } = await bannerHost();
    await dispatched(as, "BBPLUGINS-1");
    const hold = deferred();
    host.crewSnapshotHold.gate = hold.promise;
    const before = host.threadLists.length;

    const first = rpc("crew", { captainId });
    const second = rpc("crewRoster", { captainId });
    hold.resolve();
    await Promise.all([first, second]);

    expect(host.threadLists.slice(before)).toEqual([captainId]);
  });
});

describe("zero-arg RPC inputs", () => {
  test("ladders, captains, homeProjects and captainIcons accept both {} and null, and reject unknown keys", async () => {
    const { captainId, rpc } = await bannerHost();
    for (const method of ["ladders", "captains", "homeProjects", "captainIcons"] as const) {
      const withEmpty = await rpc(method, {});
      const withNull = await rpc(method, null);
      expect(withNull).toEqual(withEmpty);
      await expect(rpc(method, { unexpected: true })).rejects.toThrow(
        /rpc input validation failed/u,
      );
    }
    expect(await rpc("captains", null)).toEqual({ ids: [captainId] });
  });
});

describe("crewWatch disposal and stale context", () => {
  test("stops polling cleanly on plugin dispose without logging stale warnings", async () => {
    const { host, captainId } = await bannerHost();
    const stop = host.harness.behavior.experimental_watchRpc("crew", { input: { captainId } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const logsBefore = host.logs().length;

    await host.harness.lifecycle.dispose();
    const readsAtDispose = host.threadLists.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(host.threadLists.length).toBe(readsAtDispose);
    expect(host.logs().slice(logsBefore)).toEqual([]);
    stop();
  });

  test("breaks out of poll immediately on PluginContextStaleError instead of looping every tick", async () => {
    const { host, captainId } = await bannerHost();
    host.threadFaults.list = new PluginContextStaleError("captain");
    const readsBefore = host.threadLists.length;
    const logsBefore = host.logs().length;

    const stop = host.harness.behavior.experimental_watchRpc("crew", { input: { captainId } });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(host.threadLists.length - readsBefore).toBe(1);
    expect(host.logs().slice(logsBefore)).toEqual([]);
    stop();
  });
});
