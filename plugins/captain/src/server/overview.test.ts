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

describe("the shared crew read", () => {
  test("the banner's interaction read and the Overview's model reads start while Tasks answers", async () => {
    const { host, captainId, as, rpc, crew } = await overviewHost();
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
    const models = host.providerModels.calls;
    const banner = rpc("crew", { captainId });
    const overview = crew();
    await settle();
    // Tasks has not answered, yet both reads that need only the threads ran.
    expect(host.interactionReads).toEqual([blocked]);
    expect(host.providerModels.calls).toBe(models + 1);
    host.crewSnapshotHold.gate = null;
    release();
    const items = ((await banner) as { items: { kind: string; task: string | null }[] }).items;
    expect(items).toEqual([expect.objectContaining({ kind: "blocked", task: "BBPLUGINS-2" })]);
    expect(await overview).toEqual([expect.objectContaining({ id: blocked, task: "BBPLUGINS-2" })]);
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
