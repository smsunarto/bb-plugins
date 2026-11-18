import { describe, expect, test } from "vitest";
import { ANSWER_MAX_ATTEMPTS } from "./asks.ts";
import { STALL_WAKE_AFTER_MS } from "./check.ts";
import { COMMAND_ALLOWANCE_MS } from "./status.ts";
import { NOTICE } from "./store.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

const MINUTE = 60_000;

const run = (host: CaptainHost, argv: string[], threadId?: string) =>
  host.harness.behavior.runCli(argv, threadId === undefined ? {} : { threadId });

/** A Captain over bb-plugins with two tasks; its clock starts at 1s. */
async function checkHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.addTask("BBPLUGINS-2", { title: "Fix the sidebar" });
  host.pushes.length = 0;
  const as = (argv: string[]) => run(host, argv, captainId);
  /** Dispatch one role, then let its first turn end: the thread is idle and owes a report. */
  async function idleCrew(key: string, role = "Implement"): Promise<string> {
    const result = await as(["dispatch", key, "--role", role, "--json"]);
    if (result.exitCode !== 0) throw new Error(`dispatch failed: ${result.stdout}`);
    const parsed = JSON.parse(result.stdout) as { results: { thread: string }[] };
    const thread = parsed.results[0]?.thread ?? "";
    host.updateThread(thread, { status: "idle" });
    return thread;
  }
  /** Run one pass at `at` ms after the start, and return the messages the Captain got from it. */
  async function passAt(at: number) {
    host.setNow(1_000 + at);
    const before = host.sent.length;
    const result = await host.server.check.pass();
    return { ...result, woke: host.sent.slice(before).filter((m) => m.threadId === captainId) };
  }
  const rows = async () =>
    (
      JSON.parse((await as(["status", "--all", "--json"])).stdout) as {
        rows: { id: string; state: string; thread: string | null; note: string }[];
      }
    ).rows;
  return { host, captainId, as, idleCrew, passAt, rows };
}

describe("the stall wake", () => {
  test("wakes the Captain once, 15 minutes after a pass first saw the stall, across a reload", async () => {
    const { host, idleCrew, passAt } = await checkHost();
    const thread = await idleCrew("BBPLUGINS-1");

    const first = await passAt(2 * MINUTE);
    const early = await passAt(2 * MINUTE + STALL_WAKE_AFTER_MS - 1);
    const due = await passAt(2 * MINUTE + STALL_WAKE_AFTER_MS);
    const later = await passAt(20 * MINUTE);
    await host.reload();
    const reloaded = await passAt(30 * MINUTE);

    expect(first.woke).toEqual([]);
    expect(early.woke).toEqual([]);
    expect(due.woke).toEqual([
      {
        threadId: expect.any(String),
        text: `[captain] stalled, no report since it fell due: BBPLUGINS-1 ${thread} Implement 15m · steer them with \`bb captain tell --stalled --message-file <path>\``,
        mode: "steer-if-active",
      },
    ]);
    expect(later.woke).toEqual([]);
    expect(reloaded.woke).toEqual([]);
  });

  test("a tell moves the report-due mark, so the next stall gets one wake of its own", async () => {
    const { host, as, idleCrew, passAt } = await checkHost();
    const thread = await idleCrew("BBPLUGINS-1");
    await passAt(MINUTE);
    const firstWake = await passAt(MINUTE + STALL_WAKE_AFTER_MS);

    host.setNow(1_000 + 20 * MINUTE);
    await as(["tell", "BBPLUGINS-1", "--message", "Report what you have."]);
    const seen = await passAt(21 * MINUTE);
    const secondWake = await passAt(21 * MINUTE + STALL_WAKE_AFTER_MS);
    const after = await passAt(60 * MINUTE);

    expect(firstWake.woke).toHaveLength(1);
    expect(seen.woke).toEqual([]);
    expect(secondWake.woke).toHaveLength(1);
    expect(secondWake.woke[0]?.text).toContain(`BBPLUGINS-1 ${thread} Implement 15m`);
    expect(after.woke).toEqual([]);
  });

  test("a report wakes nobody from the check, and a thread seen working again restarts the clock", async () => {
    const { host, idleCrew, passAt } = await checkHost();
    const reporter = await idleCrew("BBPLUGINS-1");
    const resumed = await idleCrew("BBPLUGINS-2");
    await passAt(MINUTE);
    host.setNow(1_000 + 5 * MINUTE);
    host.report("BBPLUGINS-1", reporter, "Final: done");
    host.updateThread(resumed, { status: "active" });
    await passAt(10 * MINUTE);
    host.updateThread(resumed, { status: "idle" });
    const seenAgain = await passAt(12 * MINUTE);
    const pastFirstClock = await passAt(MINUTE + STALL_WAKE_AFTER_MS + MINUTE);
    const due = await passAt(12 * MINUTE + STALL_WAKE_AFTER_MS);

    expect(seenAgain.woke).toEqual([]);
    expect(pastFirstClock.woke).toEqual([]);
    expect(due.woke).toHaveLength(1);
    expect(due.woke[0]?.text).toContain(resumed);
    expect(due.woke[0]?.text).not.toContain(reporter);
  });

  test("background agents wait without limit; background commands for 30 minutes, then the thread stalls", async () => {
    const { host, idleCrew, passAt, rows } = await checkHost();
    const agents = await idleCrew("BBPLUGINS-1");
    const commands = await idleCrew("BBPLUGINS-2");
    const activity = { activePlanModeCount: 0, activeWorkflowCount: 0 };
    host.updateThread(agents, {
      activity: { ...activity, activeBackgroundAgentCount: 1, activeBackgroundCommandCount: 1 },
    });
    host.updateThread(commands, {
      activity: { ...activity, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 1 },
    });
    const state = async (thread: string) =>
      (await rows()).find((row) => row.thread === thread)?.state;

    await passAt(MINUTE);
    const before = await passAt(MINUTE + COMMAND_ALLOWANCE_MS - 1);
    const stateBefore = await state(commands);
    const spent = await passAt(MINUTE + COMMAND_ALLOWANCE_MS);
    const stateSpent = await state(commands);
    const wake = await passAt(MINUTE + COMMAND_ALLOWANCE_MS + STALL_WAKE_AFTER_MS);

    expect([before.woke, stateBefore]).toEqual([[], "waiting"]);
    expect([spent.woke, stateSpent]).toEqual([[], "stalled"]);
    expect(wake.woke).toHaveLength(1);
    expect(wake.woke[0]?.text).toContain(commands);
    expect(wake.woke[0]?.text).not.toContain(agents);
    expect(await state(agents)).toBe("waiting");
  });

  test("a child with no role row gets its preset's role, owing a report since it was created", async () => {
    const { host, captainId, passAt, rows } = await checkHost();
    host.addThread({ id: "thr_lost", parentThreadId: captainId, status: "idle", createdAt: 500 });
    host.attach(host.tasks.tasks[0]?.id ?? "", "thr_lost", "Review");

    await passAt(MINUTE);

    expect(host.server.store.crewRole("thr_lost")).toMatchObject({
      role: "review",
      reportDueSince: 500,
    });
    expect((await rows()).find((row) => row.thread === "thr_lost")?.state).toBe("stalled");
  });

  test("with Tasks down a pass writes no stall and wakes no one, and answers are still retried", async () => {
    const { host, captainId, as, idleCrew, passAt } = await checkHost();
    const thread = await idleCrew("BBPLUGINS-1");
    await as([
      "ask",
      "Pick one",
      "--task",
      "BBPLUGINS-1",
      "--option",
      "A",
      "--option",
      "B",
      "--detail",
      "Why.",
    ]);
    host.sendFails.add(captainId);
    await run(host, ["ask", "resolve", "a1", "--answer", "A"]);
    host.sendFails.delete(captainId);
    host.tasks.down = true;

    const down = await passAt(MINUTE);
    const stillDown = await passAt(MINUTE + 2 * STALL_WAKE_AFTER_MS);

    expect(down.skipped).toEqual([captainId]);
    expect(down.woke.map((message) => message.text)).toEqual([
      '[captain] a1 answered "A" · BBPLUGINS-1 Pick one',
    ]);
    expect(stillDown.woke).toEqual([]);
    expect(host.server.store.noticeSeenAt(NOTICE.stall(thread, 1_000))).toBeNull();
    expect(host.server.store.ask("a1")?.answerDeliveredAt).toBe(1_000 + MINUTE);
  });
});

describe("bb captain tell --stalled", () => {
  test("steers only the stalled crew and moves their report-due marks", async () => {
    const { host, as, idleCrew } = await checkHost();
    const stalled = await idleCrew("BBPLUGINS-1");
    const working = await idleCrew("BBPLUGINS-2");
    host.updateThread(working, { status: "active" });
    host.setNow(9_000);

    const told = await as([
      "tell",
      "--stalled",
      "--role",
      "Implement",
      "--message",
      "Post your report.",
    ]);
    const mixed = await as(["tell", "BBPLUGINS-1", "--stalled", "--message", "Hi"]);

    expect(told.stdout).toBe(`${stalled}  told  BBPLUGINS-1  Implement\n`);
    expect(host.sent.map((message) => message.threadId)).toEqual([stalled]);
    expect(host.server.store.crewRole(stalled)?.reportDueSince).toBe(9_000);
    expect(host.server.store.crewRole(working)?.reportDueSince).toBe(1_000);
    expect(mixed.exitCode).toBe(1);
    expect(mixed.stderr).toContain("targets, --stalled and --all each name the crew");
  });
});

describe("the answer retry", () => {
  test("retries a failed send with backoff, then a health row and one push; resolve retries past the cap", async () => {
    const { host, captainId, as, passAt, rows } = await checkHost();
    await as([
      "ask",
      "Pick one",
      "--task",
      "BBPLUGINS-1",
      "--option",
      "A",
      "--option",
      "B",
      "--detail",
      "Why.",
    ]);
    host.pushes.length = 0;
    host.sendFails.add(captainId);
    await run(host, ["ask", "resolve", "a1", "--answer", "A"]);
    const attempts = () => host.server.store.ask("a1")?.deliveryAttempts;
    const pushes = () => host.pushes.filter((push) => push.method === "notifications.send");

    const log: [number, number | undefined, boolean][] = [];
    for (const minute of [0.5, 1, 2, 3, 7, 8, 22, 23, 37, 38, 90]) {
      const { busy } = await passAt(minute * MINUTE);
      log.push([minute, attempts(), busy]);
    }
    const health = (await rows()).find((row) => row.id === "a1");
    host.sendFails.delete(captainId);
    const quiet = await passAt(120 * MINUTE);
    const resolved = await run(host, ["ask", "resolve", "a1", "--answer", "A"]);

    // Sends after 1, 2, 5 and 15 minutes, then 15 again, until the sixth.
    expect(log).toEqual([
      [0.5, 1, true],
      [1, 2, true],
      [2, 2, true],
      [3, 3, true],
      [7, 3, true],
      [8, 4, true],
      [22, 4, true],
      [23, 5, true],
      [37, 5, true],
      [38, ANSWER_MAX_ATTEMPTS, false],
      [90, ANSWER_MAX_ATTEMPTS, false],
    ]);
    expect(health).toMatchObject({
      state: "health",
      note: 'answer "A" not delivered after 6 sends; retry: bb captain ask resolve a1 --answer "A"',
    });
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]?.input).toMatchObject({ title: "Answer not delivered: Pick one" });
    expect(quiet.woke).toEqual([]);
    expect(resolved.stdout).toBe("a1  answered  decision  BBPLUGINS-1  A\n");
    expect((await rows()).find((row) => row.id === "a1")).toBeUndefined();
  });
});

describe("once-only pushes", () => {
  test("a report Tasks gave up delivering pushes once and shows as undeliverable", async () => {
    const { host, idleCrew, passAt, rows } = await checkHost();
    const thread = await idleCrew("BBPLUGINS-1");
    const comment = host.report("BBPLUGINS-1", thread, "Final: done");
    comment.delivery = { state: "undeliverable", reason: "gave up after 6 attempts" };

    await passAt(MINUTE);
    await passAt(2 * MINUTE);

    const pushes = host.pushes.filter((push) => push.method === "notifications.send");
    expect(pushes.map((push) => push.input)).toEqual([
      {
        title: "Report not delivered: BBPLUGINS-1",
        body: `Plugins Captain · ${thread} · gave up after 6 attempts`,
        threadId: expect.any(String),
      },
    ]);
    expect((await rows()).find((row) => row.thread === thread)?.state).toBe("undeliverable");
  });
});

describe("the pass cadence", () => {
  test("idle with no crew and no answer to retry; busy while a Captain has live crew", async () => {
    const { idleCrew, passAt } = await checkHost();

    const empty = await passAt(MINUTE);
    await idleCrew("BBPLUGINS-1");
    const withCrew = await passAt(2 * MINUTE);

    expect(empty.busy).toBe(false);
    expect(withCrew.busy).toBe(true);
  });
});

describe("status health and ready rows", () => {
  test("an errored Captain thread is a health row at the top", async () => {
    const { host, captainId, as, idleCrew } = await checkHost();
    await idleCrew("BBPLUGINS-1");
    host.updateThread(captainId, { status: "error" });

    const result = await as(["status"]);

    const [counts, first] = result.stdout.trim().split("\n");
    expect(counts).toMatch(/^1 health · 1 stalled · cursor /u);
    expect(first).toMatch(new RegExp(`^${captainId}  health  Captain thread errored  `, "u"));
  });

  test("a ready task keeps its row after its crew are archived, until it is done", async () => {
    const { host, as, idleCrew } = await checkHost();
    const implementer = await idleCrew("BBPLUGINS-1");
    const reviewer = await idleCrew("BBPLUGINS-1", "Review");
    host.report("BBPLUGINS-1", implementer, "Final: done");
    host.report("BBPLUGINS-1", reviewer, "Final: 0 findings");
    await as(["verdict", "BBPLUGINS-1", "review", "passed", "--head", "abc"]);
    for (const thread of [implementer, reviewer]) host.updateThread(thread, { archivedAt: 9_000 });
    const ready = (stdout: string) =>
      stdout.split("\n").filter((line) => line.startsWith("BBPLUGINS-1  ready"));

    const archived = await as(["status"]);
    const task = host.tasks.tasks.find((entry) => entry.key === "BBPLUGINS-1");
    if (task !== undefined) task.status = "done";
    const done = await as(["status"]);

    expect(ready(archived.stdout)).toEqual([
      "BBPLUGINS-1  ready  review passed @abc · in_review  0s",
    ]);
    expect(ready(done.stdout)).toEqual([]);
  });
});
