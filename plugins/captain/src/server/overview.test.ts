import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test, vi } from "vitest";
import { captainContract, crewTag, DRIVE_EXCERPT_BYTES, driveTag } from "../contract/rpc.ts";
import { readInside } from "./drive.ts";
import { DRIVE_WALK_MAX, listDrive, TASKS_READ_MAX, TASKS_SHOWN, watchDrive } from "./overview.ts";
import { captainHost, newCaptain, SERVER_HOST } from "./test-host.ts";

type Listing = {
  tasks: {
    key: string;
    status: string;
    ready: boolean;
    crew: { threadId: string; role: string | null; state: string } | null;
  }[];
  total: number;
  truncated: boolean;
  crewError: string | null;
  unavailable: string[];
};
type Drive = {
  total: number;
  truncated: boolean;
  files: { path: string; name: string; folder: string | null; excerpt: string | null }[];
  folder: { hostId: string; path: string } | null;
};

async function overviewHost(options: Parameters<typeof captainHost>[0] = {}) {
  const host = await captainHost(options);
  const captainId = await newCaptain(host);
  const as = (argv: string[]) => host.harness.behavior.runCli(argv, { threadId: captainId });
  const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
  const invalidations = () => host.harness.inspection.experimental_rpcInvalidations.flat();
  const tasks = async () => (await rpc("tasks", { captainId })) as Listing;
  const drive = async () => (await rpc("drive", { captainId })) as Drive;
  const driveDir = join(host.storageRoot, captainId);
  return { host, captainId, as, rpc, tasks, drive, driveDir, invalidations };
}

/** A second Captain on the same host, with two repos. */
async function overviewHostWithRepos(host: Awaited<ReturnType<typeof captainHost>>) {
  const captainId = await newCaptain(host, [
    "--name",
    "Both",
    "--repo",
    "bb-plugins",
    "--repo",
    "rampage",
  ]);
  return async () => (await host.harness.behavior.callRpc("tasks", { captainId })) as Listing;
}

async function dispatch(
  as: (
    argv: string[],
  ) => ReturnType<Awaited<ReturnType<typeof captainHost>>["harness"]["behavior"]["runCli"]>,
  key: string,
  role = "Implement",
): Promise<string> {
  const result = await as(["dispatch", key, "--role", role, "--json"]);
  if (result.exitCode !== 0) throw new Error(result.stdout);
  return (JSON.parse(result.stdout) as { results: { thread: string }[] }).results[0]?.thread ?? "";
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const SCAN_MS = 40;
/** A scan's baseline, kept as the registry keeps it. */
const scanBaseline = () => {
  let base: string | undefined;
  return {
    baseline: () => base,
    setBaseline: (signature: string | null) => {
      base = signature ?? undefined;
    },
  };
};

describe("tasks", () => {
  test("open tasks of the Captain's repos, waiting on the user first, with their crew", async () => {
    const { host, as, tasks } = await overviewHost();
    const passed = { value: "passed", head: null, writtenAt: new Date(0).toISOString() };
    host.addTask("BBPLUGINS-1", { status: "backlog", updatedAt: "2026-01-05T00:00:00.000Z" });
    host.addTask("BBPLUGINS-2", { status: "todo", updatedAt: "2026-01-04T00:00:00.000Z" });
    host.addTask("BBPLUGINS-3", { status: "in_progress", updatedAt: "2026-01-01T00:00:00.000Z" });
    host.addTask("BBPLUGINS-4", { status: "in_progress", updatedAt: "2026-01-03T00:00:00.000Z" });
    host.addTask("BBPLUGINS-5", { status: "in_review" });
    host.addTask("BBPLUGINS-6", {
      status: "in_review",
      fields: new Map([["review", passed]]),
    });
    host.addTask("BBPLUGINS-7", { status: "done" });
    host.addTask("BBPLUGINS-8", { status: "canceled" });
    host.addTask("OTHER-1", { status: "in_review" });
    const busy = await dispatch(as, "BBPLUGINS-3");
    const errored = await dispatch(as, "BBPLUGINS-5");
    host.updateThread(busy, { status: "active" });
    host.updateThread(errored, { status: "error" });

    const listing = await tasks();
    expect(listing.tasks.map((task) => task.key)).toEqual([
      "BBPLUGINS-6",
      "BBPLUGINS-5",
      "BBPLUGINS-4",
      "BBPLUGINS-3",
      "BBPLUGINS-2",
      "BBPLUGINS-1",
    ]);
    expect(listing.tasks[0]).toMatchObject({ ready: true, crew: null });
    expect(listing.tasks[1]).toMatchObject({
      ready: false,
      crew: { threadId: errored, role: "Implement", state: "errored" },
    });
    expect(listing.tasks[3]).toMatchObject({
      crew: { threadId: busy, role: "Implement", state: "working" },
    });
    expect(listing).toMatchObject({ total: 6, truncated: false, crewError: null, unavailable: [] });
  });

  test("pages past Tasks' page size and ranks the whole set before taking the rows", async () => {
    const { host, tasks } = await overviewHost();
    const passed = { value: "passed", head: null, writtenAt: new Date(0).toISOString() };
    for (let index = 1; index <= 600; index += 1) {
      host.addTask(`BBPLUGINS-${index}`, { status: "backlog" });
    }
    host.addTask("BBPLUGINS-601", { status: "in_review", fields: new Map([["review", passed]]) });
    const listing = await tasks();
    expect(listing.tasks[0]).toMatchObject({ key: "BBPLUGINS-601", ready: true });
    expect(listing.tasks).toHaveLength(TASKS_SHOWN);
    expect(listing).toMatchObject({ total: 601, truncated: false });
    const pages = host.tasks.calls.filter((call) => call.method === "listTasks");
    expect(pages.length).toBeGreaterThan(1);
  });

  test("exactly a page of tasks is not truncated; more than the read bound is", async () => {
    const { host, tasks } = await overviewHost();
    for (let index = 1; index <= 100; index += 1) host.addTask(`BBPLUGINS-${index}`);
    expect(await tasks()).toMatchObject({ total: 100, truncated: false });
    for (let index = 101; index <= TASKS_READ_MAX + 1; index += 1) {
      host.addTask(`BBPLUGINS-${index}`);
    }
    expect(await tasks()).toMatchObject({ total: TASKS_READ_MAX, truncated: true });
  });

  test("restarts a stale continuation once and drops the abandoned page", async () => {
    const { host, tasks } = await overviewHost();
    for (let index = 1; index <= 501; index += 1) host.addTask(`BBPLUGINS-${index}`);
    host.tasks.staleTaskPages = 1;
    await expect(tasks()).resolves.toMatchObject({ total: 501, truncated: false, unavailable: [] });
    expect(
      host.tasks.calls.filter((call) => call.method === "listTasks").map(({ input }) => input),
    ).toEqual([
      expect.not.objectContaining({ cursor: expect.anything() }),
      expect.objectContaining({ cursor: expect.any(String) }),
      expect.not.objectContaining({ cursor: expect.anything() }),
      expect.objectContaining({ cursor: expect.any(String) }),
    ]);

    host.tasks.staleTaskPages = 3;
    await expect(tasks()).rejects.toThrow(/task-list data changed/u);
    expect(host.tasks.staleTaskPages).toBe(1);
  });

  test("a failed crewSnapshot keeps the tasks and says the crew is unavailable", async () => {
    const { host, as, tasks } = await overviewHost();
    host.addTask("BBPLUGINS-1", { status: "in_progress" });
    await dispatch(as, "BBPLUGINS-1");
    expect((await tasks()).tasks[0]?.crew).not.toBeNull();
    host.tasks.failing.add("crewSnapshot");
    const listing = await tasks();
    expect(listing.tasks).toEqual([expect.objectContaining({ key: "BBPLUGINS-1", crew: null })]);
    expect(listing.crewError).toMatch(/crewSnapshot/u);
  });

  test("a repo whose list fails is named, and the other repos' tasks stay", async () => {
    const { host } = await overviewHost();
    const two = await overviewHostWithRepos(host);
    host.addTask("BBPLUGINS-1", { status: "todo" });
    const failed = host.tasks.projects.find((project) => project.prefix !== "BBPLUGINS");
    if (failed === undefined) throw new Error("no second project");
    host.addTask(`${failed.prefix}-1`, { status: "todo" });
    host.tasks.failing.add(`listTasks:${failed.id}`);
    const listing = await two();
    expect(listing.tasks.map((task) => task.key)).toEqual(["BBPLUGINS-1"]);
    expect(listing.unavailable).toEqual([failed.name]);
    // Every repo failing fails the read, so cached rows are labelled instead of emptied.
    const kept = host.tasks.projects.find((project) => project.prefix === "BBPLUGINS");
    host.tasks.failing.add(`listTasks:${kept?.id}`);
    await expect(two()).rejects.toThrow(/listTasks/u);
  });

  test("an archived crew thread leaves its task without crew", async () => {
    const { host, as, tasks } = await overviewHost();
    host.addTask("BBPLUGINS-1", { status: "in_progress" });
    const thread = await dispatch(as, "BBPLUGINS-1");
    host.updateThread(thread, { archivedAt: 5_000 });
    expect((await tasks()).tasks).toEqual([expect.objectContaining({ crew: null })]);
  });

  test("fails while Tasks is down, so the section says it could not load", async () => {
    const { host, tasks } = await overviewHost();
    host.addTask("BBPLUGINS-1");
    host.tasks.down = true;
    await expect(tasks()).rejects.toThrow(/scott-tasks/u);
  });

  test("shares the banner crew read's tag, so every crew refresh reaches it", () => {
    const input = { captainId: "thr_captain" };
    const tags = (method: "crew" | "tasks" | "drive") =>
      (captainContract[method].tags as (read: typeof input) => string[])(input);
    expect(tags("tasks")).toEqual(tags("crew"));
    expect(tags("drive")).toEqual([driveTag("thr_captain")]);
  });
});

describe("drive", () => {
  test("top-level rules and notes first, then the most recently changed, with excerpts", async () => {
    const { drive, driveDir } = await overviewHost();
    mkdirSync(join(driveDir, "briefs"), { recursive: true });
    mkdirSync(join(driveDir, ".cache"), { recursive: true });
    writeFileSync(join(driveDir, "briefs", "OLD.md"), "# Old brief");
    writeFileSync(join(driveDir, "briefs", "NEW.md"), "# New brief\n\nBody");
    writeFileSync(join(driveDir, "shot.png"), Buffer.from([0x89, 0x50]));
    writeFileSync(join(driveDir, ".cache", "x.md"), "hidden");
    writeFileSync(join(driveDir, ".CREW.md.abc.tmp"), "temp");
    utimesSync(join(driveDir, "briefs", "OLD.md"), 1_000, 1_000);
    utimesSync(join(driveDir, "briefs", "NEW.md"), 3_000, 3_000);
    utimesSync(join(driveDir, "shot.png"), 2_000, 2_000);

    const result = await drive();
    const names = result.files.map((file) => file.path);
    expect(names.slice(0, 3)).toEqual(["CAPTAIN.md", "CREW.md", "NOTES.md"]);
    expect(names.slice(3)).toEqual(["briefs/NEW.md", "shot.png", "briefs/OLD.md"]);
    expect(result.total).toBe(6);
    expect(result.files[3]).toMatchObject({
      name: "NEW.md",
      folder: "briefs",
      excerpt: "# New brief\n\nBody",
    });
    expect(result.files[4]).toMatchObject({ folder: null, excerpt: null });
    expect(result.folder).toEqual({ hostId: SERVER_HOST, path: driveDir });
  });

  test("a CLI write refreshes the Drive read", async () => {
    const { as, captainId, invalidations } = await overviewHost();
    const before = invalidations().length;
    const result = await as(["drive", "write", "briefs/BBPLUGINS-1.md", "--content", "# Brief"]);
    expect(result.exitCode).toBe(0);
    expect(invalidations().slice(before)).toContain(driveTag(captainId));
  });
});

describe("crew status changes", () => {
  test("a crew thread going active refreshes the read, which then shows it working", async () => {
    const { host, as, captainId, tasks, invalidations } = await overviewHost();
    host.addTask("BBPLUGINS-2", { status: "in_progress" });
    const second = await dispatch(as, "BBPLUGINS-2");
    host.updateThread(second, { status: "idle" });
    const state = async () => (await tasks()).tasks[0]?.crew?.state;
    expect(await state()).toBe("idle");

    const before = invalidations().length;
    const active = host.updateThread(second, { status: "active" });
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ ...active, parentThreadId: captainId }),
    } as never);
    expect(invalidations().slice(before)).toContain(crewTag(captainId));
    expect(await state()).toBe("working");
  });
});

describe("the shared crew read", () => {
  test("the banner's interaction read starts while Tasks answers, and the Overview shares the crew read", async () => {
    const { host, captainId, as, rpc, tasks } = await overviewHost();
    host.addTask("BBPLUGINS-2");
    const blocked = await dispatch(as, "BBPLUGINS-2");
    host.updateThread(blocked, { status: "idle", hasPendingInteraction: true });
    host.interactions.set(blocked, [
      {
        id: "int_1",
        threadId: blocked,
        status: "pending",
        createdAt: 1_000,
        payload: { kind: "plugin", title: "Approve", data: null },
      },
    ]);
    let release = () => undefined as void;
    host.crewSnapshotHold.gate = new Promise((resolve) => {
      release = resolve;
    });
    host.interactionReads.length = 0;
    const snapshots = () =>
      host.tasks.calls.filter((call) => call.method === "crewSnapshot").length;
    const before = snapshots();
    const banner = rpc("crew", { captainId });
    const overview = tasks();
    await settle();
    // Tasks has not answered, yet the read that needs only the threads ran.
    expect(host.interactionReads).toEqual([blocked]);
    host.crewSnapshotHold.gate = null;
    release();
    const items = ((await banner) as { items: { kind: string; task: string | null }[] }).items;
    expect(items).toEqual([expect.objectContaining({ kind: "blocked", task: "BBPLUGINS-2" })]);
    expect((await overview).tasks).toEqual([
      expect.objectContaining({
        key: "BBPLUGINS-2",
        crew: expect.objectContaining({ threadId: blocked, state: "needs-input" }),
      }),
    ]);
    // One crew snapshot served both reads.
    expect(snapshots() - before).toBe(1);
  });
});

describe("the Tasks recheck", () => {
  test("refreshes when only the count changes from exact to truncated", async () => {
    const { host, captainId, tasks, invalidations } = await overviewHost();
    for (let index = 1; index <= TASKS_READ_MAX; index += 1) host.addTask(`BBPLUGINS-${index}`);
    expect(await tasks()).toMatchObject({ total: TASKS_READ_MAX, truncated: false });
    const stop = host.harness.behavior.experimental_watchRpc("tasks", { input: { captainId } });
    try {
      await settle();
      const before = invalidations().length;
      host.addTask(`BBPLUGINS-${TASKS_READ_MAX + 1}`);
      await vi.waitFor(() => expect(invalidations().slice(before)).toContain(crewTag(captainId)));
      expect(await tasks()).toMatchObject({ total: TASKS_READ_MAX, truncated: true });
    } finally {
      stop();
    }
  });

  test("refreshes the missing crew link when crewSnapshot alone recovers", async () => {
    const { host, as, captainId, tasks, invalidations } = await overviewHost();
    host.addTask("BBPLUGINS-1", { status: "in_progress" });
    const threadId = await dispatch(as, "BBPLUGINS-1");
    host.tasks.failing.add("crewSnapshot");
    expect(await tasks()).toMatchObject({ crewError: expect.stringContaining("crewSnapshot") });
    const stop = host.harness.behavior.experimental_watchRpc("tasks", { input: { captainId } });
    try {
      await settle();
      const before = invalidations().length;
      host.tasks.failing.delete("crewSnapshot");
      await vi.waitFor(() => expect(invalidations().slice(before)).toContain(crewTag(captainId)));
      expect(await tasks()).toMatchObject({
        crewError: null,
        tasks: [expect.objectContaining({ crew: expect.objectContaining({ threadId }) })],
      });
    } finally {
      stop();
    }
  });

  test("a successful Retry broadcasts recovery to other watchers", async () => {
    const { host, as, captainId, tasks, invalidations } = await overviewHost({
      tasksPollMs: 60_000,
    });
    host.addTask("BBPLUGINS-1", { status: "in_progress" });
    const threadId = await dispatch(as, "BBPLUGINS-1");
    host.tasks.failing.add("crewSnapshot");
    expect(await tasks()).toMatchObject({ crewError: expect.stringContaining("crewSnapshot") });
    const stop = host.harness.behavior.experimental_watchRpc("tasks", { input: { captainId } });
    try {
      await settle();
      const before = invalidations().length;
      host.tasks.failing.delete("crewSnapshot");
      expect(await tasks()).toMatchObject({
        crewError: null,
        tasks: [expect.objectContaining({ crew: expect.objectContaining({ threadId }) })],
      });
      expect(invalidations().slice(before)).toEqual([crewTag(captainId)]);
      await tasks();
      expect(invalidations().slice(before)).toEqual([crewTag(captainId)]);
    } finally {
      stop();
    }
  });

  test("publishes task edits while a recovery probe is held and shares that probe", async () => {
    const { host, as, captainId, tasks, invalidations } = await overviewHost({
      crewPollMs: 60_000,
    });
    const task = host.addTask("BBPLUGINS-1", { status: "in_progress" });
    const threadId = await dispatch(as, task.key);
    host.tasks.failing.add("crewSnapshot");
    expect(await tasks()).toMatchObject({ crewError: expect.stringContaining("crewSnapshot") });
    const stop = host.harness.behavior.experimental_watchRpc("tasks", { input: { captainId } });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots = () =>
      host.tasks.calls.filter((call) => call.method === "crewSnapshot").length;
    const pages = () => host.tasks.calls.filter((call) => call.method === "listTasks").length;
    const tag = crewTag(captainId);
    try {
      await settle();
      const before = invalidations().length;
      const held = snapshots() + 1;
      host.crewSnapshotHold.gate = gate;
      host.tasks.failing.delete("crewSnapshot");
      task.title = "Edited while crew is unavailable";
      await vi.waitFor(() => {
        expect(snapshots()).toBe(held);
        expect(invalidations().slice(before)).toEqual([tag]);
      });
      task.title = "Edited again while crew is unavailable";
      await vi.waitFor(() => expect(invalidations().slice(before)).toEqual([tag, tag]));

      const beforeRefresh = pages();
      const refreshed = tasks();
      await vi.waitFor(() => expect(pages()).toBeGreaterThan(beforeRefresh));
      expect(snapshots()).toBe(held);
      release();
      expect(await refreshed).toMatchObject({
        crewError: null,
        tasks: [
          expect.objectContaining({
            title: "Edited again while crew is unavailable",
            crew: expect.objectContaining({ threadId }),
          }),
        ],
      });
      expect(snapshots()).toBe(held);
      expect(invalidations().slice(before)).toEqual([tag, tag, tag]);
    } finally {
      stop();
      release();
    }
  });

  test("refreshes from a new snapshot when a task edit overtakes an ordinary crew read", async () => {
    const { host, as, captainId, tasks, invalidations } = await overviewHost({
      crewPollMs: 60_000,
    });
    host.addTask("BBPLUGINS-1", { status: "in_progress" });
    const threadId = await dispatch(as, "BBPLUGINS-1");
    expect(await tasks()).toMatchObject({ crewError: null });
    const stop = host.harness.behavior.experimental_watchRpc("tasks", { input: { captainId } });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots = () =>
      host.tasks.calls.filter((call) => call.method === "crewSnapshot").length;
    try {
      await settle();
      const before = snapshots();
      const notice = invalidations().length;
      host.crewSnapshotHold.afterCapture = held;
      const original = tasks();
      await vi.waitFor(() => expect(snapshots()).toBe(before + 1));
      host.crewSnapshotHold.afterCapture = null;
      const added = host.addTask("BBPLUGINS-2", { status: "in_progress" });
      host.attach(added.id, threadId, "Captain Implement");
      await vi.waitFor(() => expect(invalidations().slice(notice)).toContain(crewTag(captainId)));

      const refreshed = tasks();
      await vi.waitFor(() => expect(snapshots()).toBe(before + 2));
      release();
      const listing = await refreshed;
      expect(listing.crewError).toBeNull();
      expect(listing.tasks.find((task) => task.key === added.key)?.crew?.threadId).toBe(threadId);
      await original;
    } finally {
      stop();
      release();
    }
  });

  test("a task changed in Tasks refreshes a watched tasks read, and stops when unwatched", async () => {
    const { host, captainId, invalidations } = await overviewHost({ crewPollMs: 60_000 });
    const task = host.addTask("BBPLUGINS-1", { status: "todo" });
    const stop = host.harness.behavior.experimental_watchRpc("tasks", { input: { captainId } });
    await settle();
    const before = invalidations().length;
    task.status = "in_progress";
    task.updatedAt = new Date(Date.now() + 1_000).toISOString();
    await settle(200);
    expect(invalidations().slice(before)).toContain(crewTag(captainId));
    stop();
    await settle();
    const after = invalidations().length;
    task.status = "in_review";
    await settle(200);
    expect(invalidations().slice(after)).not.toContain(crewTag(captainId));
  });

  test("Tasks going down and coming back each refresh the read, with nothing else changed", async () => {
    const { host, captainId, invalidations } = await overviewHost({ crewPollMs: 60_000 });
    host.addTask("BBPLUGINS-1", { status: "todo" });
    const refreshes = () => invalidations().filter((tag) => tag === crewTag(captainId)).length;
    const stop = host.harness.behavior.experimental_watchRpc("tasks", { input: { captainId } });
    await settle();
    const before = refreshes();
    host.tasks.down = true;
    await settle(200);
    const down = refreshes();
    expect(down).toBe(before + 1);
    host.tasks.down = false;
    await settle(200);
    expect(refreshes()).toBe(down + 1);
    stop();
  });
});

describe("the crew poll", () => {
  test("the banner's and the Overview's watched reads share one poll per Captain", async () => {
    // A poll interval far longer than the test: each running loop polls exactly once.
    const { host, captainId } = await overviewHost({ crewPollMs: 60_000 });
    const polls = () => host.threadLists.filter((parent) => parent === captainId).length;
    const start = polls();
    const banner = host.harness.behavior.experimental_watchRpc("crew", { input: { captainId } });
    const overview = host.harness.behavior.experimental_watchRpc("tasks", {
      input: { captainId },
    });
    await settle();
    expect(polls() - start).toBe(1);

    // With the banner gone, the loop keeps running for the Overview; with both gone, it stops.
    banner();
    overview();
    await settle();
    const again = host.harness.behavior.experimental_watchRpc("tasks", {
      input: { captainId },
    });
    await settle();
    expect(polls() - start).toBe(2);
    again();
  });
});

describe("Drive bounds", () => {
  test("a card never carries more than the excerpt cap, even from a wide cached read", async () => {
    const { as, drive } = await overviewHost();
    const big = `# Big brief\n\n${"é and more text. ".repeat(4_000)}`;
    // `drive write` caches the whole file, as a crew session build does for CREW.md.
    expect((await as(["drive", "write", "briefs/BIG.md", "--content", big])).exitCode).toBe(0);
    const card = (await drive()).files.find((file) => file.path === "briefs/BIG.md");
    expect(Buffer.byteLength(card?.excerpt ?? "")).toBeLessThanOrEqual(DRIVE_EXCERPT_BYTES);
    expect(card?.excerpt?.startsWith("# Big brief")).toBe(true);
    expect(card?.excerpt?.endsWith("\uFFFD")).toBe(false);
  });

  test("an excerpt is at most the cap and never splits a character, keeping a literal U+FFFD", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "captain-drive-")));
    const file = join(dir, "x.md");
    writeFileSync(file, "ab".repeat(30_000) + "é".repeat(1_000));
    expect(readInside(dir, file, 1_200)).toBe("ab".repeat(600));
    writeFileSync(file, `a${"é".repeat(2_000)}`);
    const head = readInside(dir, file, 1_200) ?? "";
    expect(Buffer.byteLength(head)).toBeLessThanOrEqual(1_200);
    expect(head).toBe(`a${"é".repeat(599)}`);
    // 1,196 + 3 bytes of U+FFFD fill 1,199; the 4-byte emoji does not fit.
    writeFileSync(file, `${"a".repeat(1_196)}\uFFFD🙂 and more`);
    expect(readInside(dir, file, 1_200)).toBe(`${"a".repeat(1_196)}\uFFFD`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an excerpt reads only a regular file inside the Drive: no final link, no outside folder, no FIFO", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "captain-drive-")));
    const drive = join(root, "drive");
    const outside = join(root, "outside");
    mkdirSync(drive);
    mkdirSync(outside);
    writeFileSync(join(outside, "SECRET.md"), "# secret");
    writeFileSync(join(drive, "NOTES.md"), "# notes");
    symlinkSync(join(outside, "SECRET.md"), join(drive, "link.md"));
    symlinkSync(outside, join(drive, "out"));
    execFileSync("mkfifo", [join(drive, "pipe.md")]);
    expect(readInside(drive, join(drive, "NOTES.md"), 1_200)).toBe("# notes");
    expect(readInside(drive, join(drive, "link.md"), 1_200)).toBeNull();
    expect(readInside(drive, join(drive, "out", "SECRET.md"), 1_200)).toBeNull();
    expect(readInside(drive, join(drive, "pipe.md"), 1_200)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test("a Drive that is itself a symlink out of thread storage lists nothing and offers no folder", async () => {
    const { drive, driveDir } = await overviewHost();
    const outside = mkdtempSync(join(tmpdir(), "captain-outside-"));
    writeFileSync(join(outside, "SECRET.md"), "# secret");
    rmSync(driveDir, { recursive: true, force: true });
    symlinkSync(outside, driveDir);
    expect(await drive()).toEqual({ total: 0, truncated: false, files: [], folder: null });
    expect(listDrive(driveDir).files).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  test("symlinks are never followed, and a symlink loop does not hang the walk", () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-drive-"));
    const outside = mkdtempSync(join(tmpdir(), "captain-outside-"));
    writeFileSync(join(outside, "secret.md"), "# not the Drive's");
    writeFileSync(join(dir, "NOTES.md"), "# Notes");
    symlinkSync(outside, join(dir, "outdir"));
    symlinkSync(join(outside, "secret.md"), join(dir, "linked.md"));
    symlinkSync(".", join(dir, "a"));
    symlinkSync(".", join(dir, "b"));
    expect(listDrive(dir)).toMatchObject({
      files: [expect.objectContaining({ path: "NOTES.md" })],
      truncated: false,
    });
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("the walk stops at its bound and says so; an unreadable folder skips only itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-drive-"));
    writeFileSync(join(dir, "CREW.md"), "# Crew");
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "x.md"), "x");
    chmodSync(join(dir, "locked"), 0o000);
    expect(listDrive(dir).files.map((file) => file.path)).toEqual(["CREW.md"]);
    chmodSync(join(dir, "locked"), 0o755);

    mkdirSync(join(dir, "many"));
    for (let index = 0; index < DRIVE_WALK_MAX + 100; index += 1) {
      writeFileSync(join(dir, "many", `${index}.md`), "");
    }
    const listed = listDrive(dir);
    expect(listed.truncated).toBe(true);
    expect(listed.files.length).toBeLessThan(DRIVE_WALK_MAX);
    // Breadth first: the top-level files are read before the big folder.
    expect(listed.files[0]?.path).toBe("CREW.md");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Drive scan", () => {
  /** A scan of one folder. */
  const scanned = (dir: string) => {
    let changes = 0;
    const abort = new AbortController();
    const done = watchDrive({
      ...scanBaseline(),
      scan: async () => listDrive(dir).signature,
      signal: abort.signal,
      onChange: () => {
        changes += 1;
      },
      scanMs: SCAN_MS,
    });
    return {
      changes: () => changes,
      stop: async () => {
        abort.abort();
        await done;
      },
    };
  };
  /** One scan period and a margin. */
  const oneScan = () => settle(SCAN_MS + 30);

  test("a file edit is picked up within one scan, and nothing else is pushed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-scan-"));
    writeFileSync(join(dir, "NOTES.md"), "one");
    const scan = scanned(dir);
    await oneScan();
    expect(scan.changes()).toBe(0);
    writeFileSync(join(dir, "NOTES.md"), "one, edited");
    await oneScan();
    expect(scan.changes()).toBe(1);
    await oneScan();
    expect(scan.changes()).toBe(1);
    await scan.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a folder replaced at the same path is picked up within one scan, and so are later edits in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-scan-"));
    mkdirSync(join(dir, "briefs"));
    writeFileSync(join(dir, "briefs", "a.md"), "a");
    const scan = scanned(dir);
    renameSync(join(dir, "briefs"), join(dir, ".old-briefs"));
    mkdirSync(join(dir, "briefs"));
    writeFileSync(join(dir, "briefs", "a.md"), "a");
    await oneScan();
    expect(scan.changes()).toBe(1);
    writeFileSync(join(dir, "briefs", "b.md"), "b");
    await oneScan();
    expect(scan.changes()).toBe(2);
    await scan.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an edit in the last of 280 folders is picked up within one scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-scan-"));
    for (let index = 0; index < 280; index += 1) {
      mkdirSync(join(dir, `f${String(index).padStart(3, "0")}`));
    }
    const last = listDrive(dir);
    expect(last.truncated).toBe(false);
    writeFileSync(join(dir, "f279", "deep.md"), "one");
    const scan = scanned(dir);
    writeFileSync(join(dir, "f279", "deep.md"), "one, edited");
    await oneScan();
    expect(scan.changes()).toBe(1);
    await scan.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a CLI write refreshes at once, and the next scans push nothing for it", async () => {
    const { host, as, captainId, drive, invalidations } = await overviewHost();
    const writes = () => invalidations().filter((tag) => tag === driveTag(captainId)).length;
    const stop = host.harness.behavior.experimental_watchRpc("drive", { input: { captainId } });
    await drive();
    await settle();
    const before = writes();
    await as(["drive", "write", "briefs/B.md", "--content", "# B"]);
    expect(writes() - before).toBe(1);
    await settle(200);
    expect(writes() - before).toBe(1);
    stop();
  });

  test("another client's own read does not hide an edit from the watching Overview", async () => {
    const { host, captainId, driveDir, drive, invalidations } = await overviewHost();
    const stop = host.harness.behavior.experimental_watchRpc("drive", { input: { captainId } });
    await drive();
    await settle(100);
    const before = invalidations().length;
    writeFileSync(join(driveDir, "NOTES.md"), "# Notes\n\nEdited by hand");
    // A second client reads the Drive on its own before the next scan.
    await drive();
    await settle(200);
    expect(invalidations().slice(before)).toContain(driveTag(captainId));
    stop();
  });

  test("a scan that finishes after the watch ends publishes nothing", async () => {
    let finish: (signature: string) => void = () => undefined;
    let scans = 0;
    let changes = 0;
    const abort = new AbortController();
    const done = watchDrive({
      ...scanBaseline(),
      scan: () => {
        scans += 1;
        return scans === 1
          ? Promise.resolve("before")
          : new Promise<string>((resolve) => {
              finish = resolve;
            });
      },
      signal: abort.signal,
      onChange: () => {
        changes += 1;
      },
      scanMs: SCAN_MS,
    });
    // Abort while a scan that will find a change is in flight.
    await vi.waitFor(() => expect(scans).toBe(2));
    abort.abort();
    finish("after");
    await done;
    expect(changes).toBe(0);
  });

  test("while watched, a direct edit refreshes the Drive read; unwatched, nothing does", async () => {
    const { host, captainId, driveDir, drive, invalidations } = await overviewHost();
    const stop = host.harness.behavior.experimental_watchRpc("drive", { input: { captainId } });
    await drive();
    const before = invalidations().length;
    writeFileSync(join(driveDir, "NOTES.md"), "# Notes\n\nEdited by hand");
    await settle(200);
    expect(invalidations().slice(before)).toContain(driveTag(captainId));
    stop();
    await drive();
    await settle();
    const after = invalidations().length;
    writeFileSync(join(driveDir, "NOTES.md"), "# Notes\n\nAgain");
    await settle(200);
    expect(invalidations().slice(after)).not.toContain(driveTag(captainId));
  });
});
