import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { captainContract, crewTag, driveTag } from "../contract/rpc.ts";
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
  files: { path: string; name: string; folder: string | null; excerpt: string | null }[];
  folder: { hostId: string; path: string } | null;
};

async function overviewHost() {
  const host = await captainHost();
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
        role: "plan",
      }),
      expect.objectContaining({ id: idle, status: "idle", task: "BBPLUGINS-1", role: "implement" }),
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

describe("the crew poll", () => {
  test("the banner's and the Overview's watched reads share one poll per Captain", async () => {
    const { host, captainId, as, invalidations } = await overviewHost();
    host.addTask("BBPLUGINS-1");
    const crewThread = await dispatch(as, "BBPLUGINS-1");
    const polls = () => host.threadLists.filter((parent) => parent === captainId).length;

    const banner = host.harness.behavior.experimental_watchRpc("crew", { input: { captainId } });
    const overview = host.harness.behavior.experimental_watchRpc("crewThreads", {
      input: { captainId },
    });
    await settle(30);
    const start = polls();
    const began = Date.now();
    await settle(300);
    // One loop polls at most once per interval (the test host's is 20ms); load only
    // slows it. Two loops would poll about twice that.
    expect(polls() - start).toBeLessThanOrEqual(Math.floor((Date.now() - began) / 20) + 2);
    expect(polls() - start).toBeGreaterThan(0);

    // With the banner gone, the Overview's watch still sees a new interaction.
    banner();
    await settle();
    const before = invalidations().length;
    host.updateThread(crewThread, { hasPendingInteraction: true });
    await settle();
    expect(invalidations().slice(before)).toContain(crewTag(captainId));

    overview();
    await settle();
    const stopped = polls();
    await settle();
    expect(polls()).toBe(stopped);
  });
});
