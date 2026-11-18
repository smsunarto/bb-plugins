import { describe, expect, test } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { asksTag, CAPTAINS_TAG, captainContract, crewTag, sinceTag } from "../contract/rpc.ts";
import { ANSWER_MAX_ATTEMPTS } from "./asks.ts";
import { NOTICE } from "./store.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

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
    expect(host.threads.get(started.threadId)?.title).toBe("Plugins Captain");
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
