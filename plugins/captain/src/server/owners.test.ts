import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { crewTag } from "../contract/rpc.ts";
import {
  BACKFILL_RETRY_MS,
  backfillOwners,
  createOwnerBackfill,
  briefCaptainName,
  finishOwners,
  followUpOf,
  startOwners,
  type OwnerEvidence,
} from "./owners.ts";
import { createTasksClient } from "./tasks-client.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

type Listing = { tasks: { key: string; status: string }[]; total: number };

/** Two Captains on one host that share the bb-plugins project. */
async function twoCaptains() {
  const host = await captainHost();
  const first = await newCaptain(host, ["--name", "Plugins", "--repo", "bb-plugins"]);
  const second = await newCaptain(host, ["--name", "Second", "--repo", "bb-plugins"]);
  const as = (captainId: string) => (argv: string[]) =>
    host.harness.behavior.runCli(argv, { threadId: captainId });
  const listed = async (captainId: string) =>
    ((await host.harness.behavior.callRpc("tasks", { captainId })) as Listing).tasks.map(
      (task) => task.key,
    );
  return { host, first, second, as, listed };
}

async function create(
  run: (argv: string[]) => ReturnType<CaptainHost["harness"]["behavior"]["runCli"]>,
  title: string,
  extra: string[] = [],
): Promise<string> {
  const result = await run([
    "create",
    "--project",
    "bbplugins",
    "--title",
    title,
    ...extra,
    "--json",
  ]);
  if (result.exitCode !== 0) throw new Error(`${result.stdout}${result.stderr}`);
  return (JSON.parse(result.stdout) as { results: { id: string }[] }).results[0]?.id ?? "";
}

describe("the Overview's tasks are the Captain's own", () => {
  test("two Captains sharing a project each list only the tasks they created or dispatched", async () => {
    const { host, first, second, as, listed } = await twoCaptains();
    const mine = await create(as(first), "First's task");
    const theirs = await create(as(second), "Second's task");
    // Made outside any Captain, then dispatched by the second: it becomes the second's.
    host.addTask("BBPLUGINS-9", { status: "todo" });
    const dispatched = await as(second)(["dispatch", "BBPLUGINS-9", "--role", "Implement"]);
    expect(dispatched.exitCode).toBe(0);
    // Made outside any Captain and never dispatched: nobody's.
    host.addTask("BBPLUGINS-10", { status: "todo" });

    expect(await listed(first)).toEqual([mine]);
    expect((await listed(second)).sort()).toEqual(["BBPLUGINS-9", theirs].sort());
  });

  test("a task created but not dispatched shows in backlog or todo", async () => {
    const { first, as, listed, host } = await twoCaptains();
    const backlog = await create(as(first), "Later");
    const todo = await create(as(first), "Next", ["--status", "todo", "--priority", "low"]);
    const listing = (await host.harness.behavior.callRpc("tasks", {
      captainId: first,
    })) as Listing;
    expect(listing.tasks).toEqual([
      expect.objectContaining({ key: todo, status: "todo" }),
      expect.objectContaining({ key: backlog, status: "backlog" }),
    ]);
    expect(listing.total).toBe(2);
    expect(await listed(first)).toEqual([todo, backlog]);
    expect(host.tasks.tasks.find((task) => task.key === todo)?.priority).toBe("low");
    expect(host.tasks.tasks.find((task) => task.key === backlog)?.priority).toBe("none");
  });

  test("create reads the brief from a file and refreshes the Captain's watched tasks read", async () => {
    const { host, first, as } = await twoCaptains();
    const dir = mkdtempSync(join(host.root, "brief-"));
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "You are a crew thread for the Plugins Captain.\n\nDo the thing.\n");
    const before = host.harness.inspection.experimental_rpcInvalidations.flat().length;
    const key = await create(as(first), "From a file", ["--description-file", brief]);
    expect(host.tasks.tasks.find((task) => task.key === key)?.description).toMatch(/Do the thing/u);
    expect(host.harness.inspection.experimental_rpcInvalidations.flat().slice(before)).toContain(
      crewTag(first),
    );
  });

  test("create refuses a project outside the Captain's repos and creates nothing", async () => {
    const { host, first, as } = await twoCaptains();
    const count = host.tasks.tasks.length;
    const result = await as(first)(["create", "--project", "rampage", "--title", "x"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("RAMPAGE is not in this Captain's repos (BBPLUGINS)");
    expect(result.stderr).toContain("bb captain repo add <project> --tasks RAMPAGE");
    expect(host.tasks.tasks.length).toBe(count);
  });

  test("create refuses a crew thread", async () => {
    const { host, first, as } = await twoCaptains();
    host.addTask("BBPLUGINS-1", { status: "todo" });
    const dispatched = await as(first)([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--json",
    ]);
    const crew = (JSON.parse(dispatched.stdout) as { results: { thread: string }[] }).results[0]
      ?.thread;
    const result = await host.harness.behavior.runCli(
      ["create", "--project", "BBPLUGINS", "--title", "x"],
      { threadId: crew ?? "" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/crew cannot create tasks/u);
  });

  test("a create Tasks answers after the deadline says to look for the task before a rerun", async () => {
    const { host, first, as, listed } = await twoCaptains();
    host.tasks.createTaskHangs = true;
    const result = await as(first)(["create", "--project", "BBPLUGINS", "--title", "Slow one"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Tasks may still have created the task");
    expect(result.stderr).toContain('bb tasks list --search "Slow one"');
    expect(result.stderr).toContain("bb captain claim <key>");
    // Tasks made it, unowned; claim is the way back.
    expect(host.tasks.tasks.map((task) => task.title)).toContain("Slow one");
    expect(await listed(first)).toEqual([]);
  });

  test("a watched read refreshes for the Captain's own task, not for another Captain's", async () => {
    const { host, first, second, as } = await twoCaptains();
    const mine = await create(as(first), "Mine");
    const theirs = await create(as(second), "Theirs");
    const stop = host.harness.behavior.experimental_watchRpc("tasks", {
      input: { captainId: first },
    });
    const refreshes = () =>
      host.harness.inspection.experimental_rpcInvalidations
        .flat()
        .filter((tag) => tag === crewTag(first)).length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const before = refreshes();
    const edit = (key: string) => {
      const task = host.tasks.tasks.find((entry) => entry.key === key);
      if (task === undefined) throw new Error(`no ${key}`);
      task.status = "in_progress";
      task.updatedAt = new Date(Date.now() + 5_000).toISOString();
    };
    edit(theirs);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(refreshes()).toBe(before);
    edit(mine);
    await vi.waitFor(() => expect(refreshes()).toBeGreaterThan(before));
    stop();
  });
});

describe("dispatch", () => {
  test("a refused spawn leaves the task unowned", async () => {
    const { host, first, as, listed } = await twoCaptains();
    host.addTask("BBPLUGINS-1", { status: "todo" });
    host.tasks.delegateMode = "refuse";
    const result = await as(first)(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);
    expect(result.exitCode).toBe(1);
    expect(await listed(first)).toEqual([]);
  });
});

describe("claim", () => {
  test("claims an existing task for the calling Captain only, and refuses an unknown key", async () => {
    const { host, first, second, as, listed } = await twoCaptains();
    host.addTask("BBPLUGINS-4", { status: "backlog" });
    expect(await listed(first)).toEqual([]);
    const claimed = await as(first)(["claim", "bbplugins-4"]);
    expect(claimed.exitCode).toBe(0);
    expect(claimed.stdout).toMatch(/^BBPLUGINS-4 {2}claimed/u);
    expect(await listed(first)).toEqual(["BBPLUGINS-4"]);
    expect(await listed(second)).toEqual([]);
    const refused = await as(first)(["claim", "BBPLUGINS-404"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/no task BBPLUGINS-404/u);
  });

  test("dedupes keys after upper-casing, and prints a title on one line", async () => {
    const { host, first, as } = await twoCaptains();
    host.addTask("BBPLUGINS-4", { status: "backlog", title: "Two\nBBPLUGINS-9  claimed  lines" });
    const claimed = await as(first)(["claim", "bbplugins-4", "BBPLUGINS-4"]);
    expect(claimed.stdout).toBe("BBPLUGINS-4  claimed  Two BBPLUGINS-9  claimed  lines\n");
  });

  test("release drops only this Captain's ownership", async () => {
    const { host, first, second, as, listed } = await twoCaptains();
    host.addTask("BBPLUGINS-4", { status: "backlog" });
    await as(first)(["claim", "BBPLUGINS-4"]);
    await as(second)(["claim", "BBPLUGINS-4"]);
    const released = await as(first)(["release", "bbplugins-4"]);
    expect(released.stdout).toMatch(/^BBPLUGINS-4 {2}released/u);
    expect(await listed(first)).toEqual([]);
    expect(await listed(second)).toEqual(["BBPLUGINS-4"]);
    const again = await as(first)(["release", "BBPLUGINS-4"]);
    expect(again.stdout).toMatch(/^BBPLUGINS-4 {2}not owned/u);
  });
});

describe("the brief header and follow-up lines", () => {
  test("read the Captain name and the followed task from the first line", () => {
    expect(briefCaptainName("You are a crew thread for the bb Captain.\n\nWork")).toBe("bb");
    expect(briefCaptainName("\n  You are a crew thread for the World Engine Captain.")).toBe(
      "world engine",
    );
    expect(briefCaptainName("# Title\n\nYou are a crew thread for the bb Captain.")).toBeNull();
    expect(followUpOf("Follow-up from BBP-94 review round 2 (low).")).toBe("BBP-94");
    expect(followUpOf("Low follow-ups from BBP-41 review round 4")).toBe("BBP-41");
    expect(followUpOf("Follow-up lows from BBP-43 round 2")).toBe("BBP-43");
    expect(followUpOf("From BBP-80 review round 2 (head 803bd451)")).toBe("BBP-80");
    expect(followUpOf("Low test gap (nonblocking), from the WORLDENGIN-4 final review")).toBe(
      "WORLDENGIN-4",
    );
    expect(followUpOf("THINGS-1 round-2 review findings 8 and 10")).toBe("THINGS-1");
    expect(followUpOf("Follow-up from the #1376 re-review")).toBeNull();
    expect(followUpOf("Fix the thing")).toBeNull();
  });
});

describe("follow-up chains", () => {
  test("a follow-up of a follow-up, or of a task a comment placed, is placed in any order", () => {
    const evidence: OwnerEvidence = {
      captains: [{ id: "thr_a", names: ["A"] }],
      recorded: [],
      dispatched: [{ captainId: "thr_a", taskId: "t1", taskKey: "BBP-1" }],
      open: [
        { id: "t3", key: "BBP-3", description: "Follow-up from BBP-2" },
        { id: "t2", key: "BBP-2", description: "Follow-up from BBP-1" },
        { id: "t6", key: "BBP-6", description: "Follow-up from BBP-5" },
        { id: "t5", key: "BBP-5", description: "Decision task (no crew)." },
      ],
    };
    const authors = new Map([
      ["t5", [{ kind: "agent", authorName: "A Captain", threadId: "thr_a" }]],
    ]);
    const { assignments, unowned } = finishOwners(evidence, startOwners(evidence), authors);
    expect(unowned).toEqual([]);
    expect(assignments.map((each) => `${each.taskKey}:${each.rule}`)).toEqual([
      "BBP-1:dispatched",
      "BBP-2:follow-up",
      "BBP-3:follow-up",
      "BBP-5:commented",
      "BBP-6:follow-up",
    ]);
  });

  const commentedParent: OwnerEvidence = {
    captains: [
      { id: "thr_a", names: ["A"] },
      { id: "thr_b", names: ["B"] },
    ],
    recorded: [],
    dispatched: [],
    open: [
      { id: "t6", key: "BBP-6", description: "Follow-up from BBP-5 review round 2" },
      { id: "t5", key: "BBP-5", description: "Decision task (no crew)." },
    ],
  };

  test("a follow-up goes with a parent a comment placed, over another Captain's comment on it", () => {
    const authors = new Map([
      ["t5", [{ kind: "agent", authorName: "A Captain", threadId: "thr_a" }]],
      ["t6", [{ kind: "agent", authorName: "B Captain", threadId: "thr_b" }]],
    ]);
    const { assignments, unowned } = finishOwners(
      commentedParent,
      startOwners(commentedParent),
      authors,
    );
    expect(unowned).toEqual([]);
    expect(assignments.map((each) => `${each.taskKey}:${each.captainId}:${each.rule}`)).toEqual([
      "BBP-5:thr_a:commented",
      "BBP-6:thr_a:follow-up",
    ]);
  });

  test("a follow-up whose parent nothing places falls back to its own comment", () => {
    const authors = new Map([
      ["t6", [{ kind: "agent", authorName: "B Captain", threadId: "thr_b" }]],
    ]);
    const { assignments, unowned } = finishOwners(
      commentedParent,
      startOwners(commentedParent),
      authors,
    );
    expect(unowned.map((task) => task.key)).toEqual(["BBP-5"]);
    expect(assignments.map((each) => `${each.taskKey}:${each.captainId}:${each.rule}`)).toEqual([
      "BBP-6:thr_b:commented",
    ]);
  });

  test("follow-ups that name each other are decided by their comments", () => {
    const evidence: OwnerEvidence = {
      captains: [{ id: "thr_a", names: ["A"] }],
      recorded: [],
      dispatched: [],
      open: [
        { id: "t7", key: "BBP-7", description: "Follow-up from BBP-8" },
        { id: "t8", key: "BBP-8", description: "Follow-up from BBP-7" },
      ],
    };
    const authors = new Map([
      ["t8", [{ kind: "agent", authorName: "A Captain", threadId: "thr_a" }]],
    ]);
    const { assignments, unowned } = finishOwners(evidence, startOwners(evidence), authors);
    expect(unowned).toEqual([]);
    expect(assignments.map((each) => `${each.taskKey}:${each.rule}`)).toEqual([
      "BBP-8:commented",
      "BBP-7:follow-up",
    ]);
  });
});

describe("the backfill's inference", () => {
  // Shaped on live data: thr_bb is "Plugins" in the registry and "bb" as its thread title.
  const evidence: OwnerEvidence = {
    captains: [
      { id: "thr_bb", names: ["Plugins", "bb"] },
      { id: "thr_cap", names: ["Captain", "Captain"] },
      { id: "thr_twin1", names: ["Twin", "Twin"] },
      { id: "thr_twin2", names: ["Twin", "Twin"] },
    ],
    recorded: [],
    dispatched: [
      { captainId: "thr_bb", taskId: "t94", taskKey: "BBP-94" },
      { captainId: "thr_cap", taskId: "t41", taskKey: "BBP-41" },
      { captainId: "thr_cap", taskId: "t100", taskKey: "BBP-100" },
      { captainId: "thr_bb", taskId: "t79", taskKey: "BBP-79" },
    ],
    open: [
      { id: "t100", key: "BBP-100", description: "You are a crew thread for the Captain Captain." },
      { id: "t102", key: "BBP-102", description: "You are a crew thread for the Captain Captain." },
      { id: "t97", key: "BBP-97", description: "You are a crew thread for the bb Captain." },
      { id: "t35", key: "BBP-35", description: "You are a crew thread for the Plugins Captain." },
      { id: "t61", key: "BBP-61", description: "Low follow-ups from BBP-41 review round 4" },
      { id: "t98", key: "BBP-98", description: "Follow-up from BBP-94 review round 2" },
      { id: "t7", key: "BBP-7", description: "You are a crew thread for the Twin Captain." },
      { id: "t79", key: "BBP-79", description: "Follow-ups from BBP-63 review round 2" },
      { id: "t5", key: "BBP-5", description: "Decision task (no crew)." },
      { id: "t6", key: "BBP-6", description: "Fix the thing" },
    ],
  };
  const authors = new Map([
    // The bb Captain set its priority: a system line from its thread.
    ["t61", [{ kind: "system", authorName: "agent (thr_bb)", threadId: null }]],
    // Only the Captain Captain's own thread commented: a last-resort claim.
    ["t5", [{ kind: "agent", authorName: "Captain Captain", threadId: "thr_cap" }]],
    // A crew thread's comment names no Captain.
    ["t6", [{ kind: "agent", authorName: "agent (thr_crew)", threadId: "thr_crew" }]],
    // The other Captain commented on a task the bb Captain dispatched: no claim.
    ["t79", [{ kind: "agent", authorName: "agent (thr_cap)", threadId: "thr_cap" }]],
  ]);

  test("places tasks by crew, brief header, Captain edit, follow-up, then comment", () => {
    const started = startOwners(evidence);
    expect(started.unowned.map((task) => task.key)).toEqual([
      "BBP-61",
      "BBP-98",
      "BBP-7",
      "BBP-5",
      "BBP-6",
    ]);
    const { assignments, unowned } = finishOwners(evidence, started, authors);
    const owners = (key: string) =>
      assignments
        .filter((each) => each.taskKey === key)
        .map((each) => `${each.captainId}:${each.rule}`);
    expect(owners("BBP-100")).toEqual(["thr_cap:dispatched"]);
    expect(owners("BBP-102")).toEqual(["thr_cap:brief"]);
    expect(owners("BBP-97")).toEqual(["thr_bb:brief"]);
    expect(owners("BBP-35")).toEqual(["thr_bb:brief"]);
    // The edit wins over the follow-up line, which points at the other Captain's task.
    expect(owners("BBP-61")).toEqual(["thr_bb:edited"]);
    expect(owners("BBP-98")).toEqual(["thr_bb:follow-up"]);
    expect(owners("BBP-5")).toEqual(["thr_cap:commented"]);
    expect(owners("BBP-79")).toEqual(["thr_bb:dispatched"]);
    // Two Captains answer to "Twin", and a crew thread's comment is no claim.
    expect(unowned.map((task) => task.key)).toEqual(["BBP-7", "BBP-6"]);
  });
});

type Backfilled = Listing & { owners: string };

/** Forget every owner and the backfill's done marker, as before this change shipped. */
function forgetOwners(host: CaptainHost): void {
  const db = host.bb.storage.database();
  db.prepare("DELETE FROM task_owners").run();
  db.prepare("DELETE FROM notices WHERE key = ?").run("owner-backfill");
}

const backfill = (host: CaptainHost) =>
  backfillOwners({
    bb: host.bb,
    store: host.server.store,
    tasks: createTasksClient(host.bb),
    now: host.now,
  });

function systemLine(host: CaptainHost, taskId: string, captainId: string): void {
  host.tasks.comments.push({
    id: `c${host.tasks.comments.length + 1}`,
    taskId,
    body: "Priority changed to Low",
    authorName: `agent (${captainId})`,
    source: { kind: "system" } as never,
    threadId: undefined,
    notifyParent: false,
    delivery: { state: "none" },
    createdAt: new Date(0).toISOString(),
  });
}

describe("the backfill", () => {
  test("records owners from crew, briefs and edits, and the Overview then lists them", async () => {
    const { host, first, second, as, listed } = await twoCaptains();
    // A crew thread dispatched before ownership was recorded: its role row alone remains.
    host.addTask("BBPLUGINS-1", { status: "in_progress" });
    expect((await as(second)(["dispatch", "BBPLUGINS-1", "--role", "Implement"])).exitCode).toBe(0);
    forgetOwners(host);
    host.addTask("BBPLUGINS-2", {
      status: "backlog",
      description: "You are a crew thread for the Plugins Captain.\n\nBrief.",
    });
    const edited = host.addTask("BBPLUGINS-3", { status: "backlog", description: "Lows." });
    systemLine(host, edited.id, second);
    expect(await backfill(host)).toEqual({
      complete: true,
      counts: { dispatched: 1, brief: 1, edited: 1 },
      unowned: [],
      unreadable: [],
    });
    expect(host.server.store.taskOwnerBackfilled()).toBe(true);
    expect(await listed(first)).toEqual(["BBPLUGINS-2"]);
    expect((await listed(second)).sort()).toEqual(["BBPLUGINS-1", "BBPLUGINS-3"]);
  });

  test("a failed comment read keeps crew and brief owners, is labelled, and retries after a delay", async () => {
    const { host, first, as } = await twoCaptains();
    host.addTask("BBPLUGINS-1", { status: "todo" });
    expect((await as(first)(["dispatch", "BBPLUGINS-1", "--role", "Implement"])).exitCode).toBe(0);
    forgetOwners(host);
    host.addTask("BBPLUGINS-2", {
      status: "todo",
      description: "You are a crew thread for the Plugins Captain.",
    });
    const edited = host.addTask("BBPLUGINS-3", { status: "todo", description: "Lows." });
    systemLine(host, edited.id, first);
    host.tasks.failing.add("listComments");
    const read = async () =>
      (await host.harness.behavior.callRpc("tasks", { captainId: first })) as Backfilled;
    const failed = await read();
    expect(failed.owners).toBe("failed");
    expect(failed.tasks.map((task) => task.key).sort()).toEqual(["BBPLUGINS-1", "BBPLUGINS-2"]);
    host.tasks.failing.delete("listComments");
    const comments = () => host.tasks.calls.filter((call) => call.method === "listComments");
    const before = comments().length;
    // Inside the retry delay a read does not rerun it.
    expect((await read()).owners).toBe("failed");
    expect(comments().length).toBe(before);
    host.setNow(host.now() + BACKFILL_RETRY_MS);
    const ready = await read();
    expect(ready.owners).toBe("ready");
    expect(ready.tasks.map((task) => task.key).sort()).toEqual([
      "BBPLUGINS-1",
      "BBPLUGINS-2",
      "BBPLUGINS-3",
    ]);
  });

  test("an unreadable project leaves the run incomplete and unmarked, with the rest written", async () => {
    const { host, first, as } = await twoCaptains();
    host.addTask("BBPLUGINS-1", { status: "todo" });
    expect((await as(first)(["dispatch", "BBPLUGINS-1", "--role", "Implement"])).exitCode).toBe(0);
    forgetOwners(host);
    const project = host.tasks.projects.find((entry) => entry.prefix === "BBPLUGINS");
    host.tasks.failing.add(`listTasks:${project?.id}`);
    const result = await backfill(host);
    expect(result).toMatchObject({ complete: false, unreadable: ["BBPLUGINS"] });
    expect(result.counts).toEqual({ dispatched: 1 });
    expect(host.server.store.taskOwnerBackfilled()).toBe(false);
  });

  test("a failed Captain title read rejects and marks nothing", async () => {
    const { host } = await twoCaptains();
    forgetOwners(host);
    const down = Promise.reject(new Error("bb did not answer"));
    down.catch(() => undefined);
    host.threadHolds.get = down;
    await expect(backfill(host)).rejects.toThrow(/bb did not answer/u);
    host.threadHolds.get = null;
    expect(host.server.store.taskOwnerBackfilled()).toBe(false);
  });

  test("a live Captain whose thread bb no longer has does not stop the others' owners", async () => {
    const host = await captainHost();
    const first = await newCaptain(host, ["--name", "Plugins", "--repo", "bb-plugins"]);
    const gone = await newCaptain(host, ["--name", "Work", "--repo", "bb-plugins"]);
    const run = (argv: string[]) => host.harness.behavior.runCli(argv, { threadId: first });
    host.addTask("BBPLUGINS-1", { status: "in_progress" });
    expect((await run(["dispatch", "BBPLUGINS-1", "--role", "Implement"])).exitCode).toBe(0);
    host.addTask("BBPLUGINS-2", {
      status: "todo",
      description: "You are a crew thread for the Plugins Captain.",
    });
    forgetOwners(host);
    host.threads.delete(gone);
    const listing = (await host.harness.behavior.callRpc("tasks", {
      captainId: first,
    })) as Listing & {
      owners: string;
    };
    expect(listing.owners).toBe("ready");
    expect(listing.tasks.map((task) => task.key).sort()).toEqual(["BBPLUGINS-1", "BBPLUGINS-2"]);
    expect(host.server.store.taskOwnerBackfilled()).toBe(true);
  });

  test("a Captain title read that never answers fails the run at its deadline, crew owners kept", async () => {
    const { host, first, as } = await twoCaptains();
    host.addTask("BBPLUGINS-1", { status: "todo" });
    expect((await as(first)(["dispatch", "BBPLUGINS-1", "--role", "Implement"])).exitCode).toBe(0);
    forgetOwners(host);
    host.threadHolds.get = new Promise(() => undefined);
    const owners = createOwnerBackfill(
      { bb: host.bb, store: host.server.store, tasks: createTasksClient(host.bb), now: host.now },
      { titleDeadlineMs: 20 },
    );
    await owners.ensure();
    host.threadHolds.get = null;
    expect(owners.state()).toBe("failed");
    expect(host.server.store.ownedTaskIds(first).size).toBe(1);
    expect(host.server.store.taskOwnerBackfilled()).toBe(false);
  });

  test("its end refreshes a watched tasks read", async () => {
    const { host, first } = await twoCaptains();
    forgetOwners(host);
    host.addTask("BBPLUGINS-2", {
      status: "todo",
      description: "You are a crew thread for the Plugins Captain.",
    });
    const invalidations = () => host.harness.inspection.experimental_rpcInvalidations.flat();
    const before = invalidations().length;
    const stop = host.harness.behavior.experimental_watchRpc("tasks", {
      input: { captainId: first },
    });
    await vi.waitFor(() => expect(host.server.store.taskOwnerBackfilled()).toBe(true));
    stop();
    expect(invalidations().slice(before)).toContain(crewTag(first));
  });
});

describe("crew attached outside dispatch", () => {
  test("a child the check adopts as crew makes its task the Captain's", async () => {
    const { host, first, listed } = await twoCaptains();
    const task = host.addTask("BBPLUGINS-77", { status: "in_progress" });
    host.addThread({ id: "thr_lost", parentThreadId: first, status: "idle", createdAt: 500 });
    host.attach(task.id, "thr_lost", "Review");
    await host.server.check.pass();
    expect(host.server.store.crewRole("thr_lost")).toMatchObject({ role: "review" });
    expect(await listed(first)).toEqual(["BBPLUGINS-77"]);
  });

  test("a child mid-adoption is left to the adoption, which records its task itself", async () => {
    const { host, first, listed } = await twoCaptains();
    const task = host.addTask("BBPLUGINS-78", { status: "in_progress" });
    host.addThread({ id: "thr_adopting", parentThreadId: first, status: "idle", createdAt: 500 });
    host.attach(task.id, "thr_adopting", "Review");
    host.server.store.beginAdoption("thr_adopting", first, task);
    await host.server.check.pass();
    expect(host.server.store.crewRole("thr_adopting")).toBeNull();
    expect(await listed(first)).toEqual([]);
  });
});
