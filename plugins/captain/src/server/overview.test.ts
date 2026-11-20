import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test } from "vitest";
import { captainContract, crewTag, DRIVE_EXCERPT_BYTES, driveTag } from "../contract/rpc.ts";
import { createDrive } from "./drive.ts";
import { DRIVE_WALK_MAX, listDrive, watchDrive } from "./overview.ts";
import { captainHost, newCaptain, SERVER_HOST } from "./test-host.ts";

type Thread = {
  id: string;
  title: string;
  status: string;
  model: string | null;
  task: string | null;
  role: string | null;
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
  const crew = async () =>
    ((await rpc("crewThreads", { captainId })) as { threads: Thread[] }).threads;
  const drive = async () => (await rpc("drive", { captainId })) as Drive;
  const driveDir = join(host.storageRoot, captainId);
  return { host, captainId, as, rpc, crew, drive, driveDir, invalidations };
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

describe("crewThreads", () => {
  test("lists the unarchived crew, active first, with model name, task and role", async () => {
    const { host, as, crew } = await overviewHost();
    host.addTask("BBPLUGINS-1", { title: "Render PR images" });
    host.addTask("BBPLUGINS-2", { title: "Fix the sidebar" });
    host.addTask("BBPLUGINS-3", { title: "Old work" });
    const idle = await dispatch(as, "BBPLUGINS-1");
    const busy = await dispatch(as, "BBPLUGINS-2", "Plan");
    const gone = await dispatch(as, "BBPLUGINS-3");
    host.updateThread(idle, { status: "idle", updatedAt: 9_000 });
    host.updateThread(busy, { status: "active", updatedAt: 2_000 });
    host.updateThread(gone, { archivedAt: 5_000 });

    expect(await crew()).toEqual([
      expect.objectContaining({
        id: busy,
        status: "active",
        model: "Claude Opus 5.5",
        task: "BBPLUGINS-2",
        role: "Plan",
      }),
      expect.objectContaining({ id: idle, status: "idle", task: "BBPLUGINS-1", role: "Implement" }),
    ]);
  });

  test("keeps every thread while Tasks is down, without its task", async () => {
    const { host, as, crew } = await overviewHost();
    host.addTask("BBPLUGINS-1");
    const thread = await dispatch(as, "BBPLUGINS-1");
    host.tasks.down = true;
    expect(await crew()).toEqual([expect.objectContaining({ id: thread, task: null })]);
  });

  test("shares the banner crew read's tag, so every crew refresh reaches it", () => {
    const input = { captainId: "thr_captain" };
    const tags = (method: "crew" | "crewThreads" | "drive") =>
      (captainContract[method].tags as (read: typeof input) => string[])(input);
    expect(tags("crewThreads")).toEqual(tags("crew"));
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

  test("while watched, a direct file edit refreshes the Drive read; unwatched, nothing does", async () => {
    const { host, captainId, driveDir, invalidations } = await overviewHost();
    const stop = host.harness.behavior.experimental_watchRpc("drive", { input: { captainId } });
    await settle();
    const before = invalidations().length;
    writeFileSync(join(driveDir, "NOTES.md"), "# Notes\n\nEdited by hand");
    await settle(600);
    expect(invalidations().slice(before)).toContain(driveTag(captainId));
    stop();
    await settle();
    const after = invalidations().length;
    writeFileSync(join(driveDir, "NOTES.md"), "# Notes\n\nAgain");
    await settle(600);
    expect(invalidations().slice(after)).not.toContain(driveTag(captainId));
  });
});

describe("crew status changes", () => {
  test("a crew thread going active refreshes the read, which then lists it first", async () => {
    const { host, as, captainId, crew, invalidations } = await overviewHost();
    host.addTask("BBPLUGINS-1");
    host.addTask("BBPLUGINS-2");
    const first = await dispatch(as, "BBPLUGINS-1");
    const second = await dispatch(as, "BBPLUGINS-2");
    host.updateThread(first, { status: "idle", updatedAt: 9_000 });
    host.updateThread(second, { status: "idle", updatedAt: 2_000 });
    expect((await crew()).map((thread) => thread.id)).toEqual([first, second]);

    const before = invalidations().length;
    const active = host.updateThread(second, { status: "active" });
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ ...active, parentThreadId: captainId }),
    } as never);
    expect(invalidations().slice(before)).toContain(crewTag(captainId));
    expect((await crew()).map((thread) => [thread.id, thread.status])).toEqual([
      [second, "active"],
      [first, "idle"],
    ]);
  });
});

describe("the crew poll", () => {
  test("the banner's and the Overview's watched reads share one poll per Captain", async () => {
    // A poll interval far longer than the test: each running loop polls exactly once.
    const { host, captainId } = await overviewHost({ crewPollMs: 60_000 });
    const polls = () => host.threadLists.filter((parent) => parent === captainId).length;
    const start = polls();
    const banner = host.harness.behavior.experimental_watchRpc("crew", { input: { captainId } });
    const overview = host.harness.behavior.experimental_watchRpc("crewThreads", {
      input: { captainId },
    });
    await settle();
    expect(polls() - start).toBe(1);

    // With the banner gone, the loop keeps running for the Overview; with both gone, it stops.
    banner();
    overview();
    await settle();
    const again = host.harness.behavior.experimental_watchRpc("crewThreads", {
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

  test("head caps a wide cached read and never splits a character", () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-drive-"));
    const file = join(dir, "x.md");
    writeFileSync(file, "ab".repeat(30_000) + "é".repeat(1_000));
    const store = createDrive();
    store.read(file);
    expect(store.head(file, 1_200)).toBe("ab".repeat(600));
    writeFileSync(file, `a${"é".repeat(2_000)}`);
    const head = store.head(file, 1_200) ?? "";
    expect(Buffer.byteLength(head)).toBeLessThanOrEqual(1_200);
    expect(head).toBe(`a${"é".repeat(599)}`);
    rmSync(dir, { recursive: true, force: true });
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
    expect(listDrive(dir)).toEqual({
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

describe("Drive watch", () => {
  const watched = (dir: () => string | null) => {
    const changes: number[] = [];
    const live: boolean[] = [];
    const abort = new AbortController();
    const done = watchDrive({
      resolveDir: async () => dir(),
      signal: abort.signal,
      onChange: () => changes.push(Date.now()),
      onLive: (state) => live.push(state),
      warn: () => undefined,
      retryMs: 40,
      settleMs: 30,
    });
    return {
      changes,
      live,
      stop: async () => {
        abort.abort();
        await done;
      },
    };
  };

  test("a watch whose folder is missing at start, or is deleted and recreated, starts again", async () => {
    const root = mkdtempSync(join(tmpdir(), "captain-watch-"));
    const dir = join(root, "drive");
    let known: string | null = null;
    const watch = watched(() => known);
    // No storage root yet, then no folder yet.
    await settle(100);
    known = dir;
    await settle(100);
    mkdirSync(dir);
    await settle(150);
    const started = watch.changes.length;
    expect(watch.live).toContain(true);
    writeFileSync(join(dir, "NOTES.md"), "one");
    await settle(150);
    expect(watch.changes.length).toBeGreaterThan(started);

    rmSync(dir, { recursive: true, force: true });
    await settle(100);
    mkdirSync(dir);
    await settle(150);
    const recreated = watch.changes.length;
    writeFileSync(join(dir, "NOTES.md"), "two");
    await settle(150);
    expect(watch.changes.length).toBeGreaterThan(recreated);
    await watch.stop();
    expect(watch.live.at(-1)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("a steady stream of writes keeps refreshing rather than waiting for a pause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-watch-"));
    const watch = watched(() => dir);
    await settle(60);
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(dir, "NOTES.md"), String(index));
      await settle(25);
    }
    expect(watch.changes.length).toBeGreaterThanOrEqual(3);
    await watch.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a CLI write refreshes once: by itself when unwatched, by the watch when watched", async () => {
    const { host, as, captainId, invalidations } = await overviewHost();
    const writes = () => invalidations().filter((tag) => tag === driveTag(captainId)).length;
    let before = writes();
    await as(["drive", "write", "briefs/A.md", "--content", "# A"]);
    await settle(400);
    expect(writes() - before).toBe(1);

    const stop = host.harness.behavior.experimental_watchRpc("drive", { input: { captainId } });
    await settle();
    before = writes();
    await as(["drive", "write", "briefs/B.md", "--content", "# B"]);
    await settle(600);
    expect(writes() - before).toBe(1);
    stop();
  });
});

describe("the provider catalog", () => {
  test("a failed catalog read is not kept: the next read shows model names", async () => {
    const { host, as, crew } = await overviewHost();
    host.addTask("BBPLUGINS-1");
    await dispatch(as, "BBPLUGINS-1");
    host.providerModels.fails = 1;
    expect((await crew())[0]?.model).toBe("claude-opus-5-5");
    expect((await crew())[0]?.model).toBe("Claude Opus 5.5");
    const calls = host.providerModels.calls;
    await crew();
    expect(host.providerModels.calls).toBe(calls);
  });
});
