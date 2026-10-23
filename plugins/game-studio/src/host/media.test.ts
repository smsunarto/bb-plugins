import { afterEach, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mediaRequest } from "../shared/generation.ts";
import { place, previewUrl } from "../shared/media-paths.ts";
import { nodeDisk } from "./canvas.ts";
import { collectCanvas } from "./collect.ts";
import { GenerationRunner } from "./generation.ts";
import { LEGACY_GRACE_MS, Media, MOVED_NOTE } from "./media.ts";

const temporary: string[] = [];
const runners: GenerationRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function folder() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "studio-media-test-")));
  temporary.push(path);
  return path;
}
async function put(root: string, path: string, content: string, { old = false } = {}) {
  const file = join(root, ...path.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  if (old) await utimes(file, 1, 1);
}
const read = (root: string, path: string) => readFile(join(root, ...path.split("/")), "utf8");
const gone = (root: string, path: string) =>
  stat(join(root, ...path.split("/"))).then(
    () => false,
    () => true,
  );
const idle = { busy: async () => false, note: "Moved to {{mediaDir}}" };

test("canvas paths name staged media and snapshots in the media folder, and checkout files in it", () => {
  expect(place("/game", "/media", "canvas/staging/run/a.png")).toEqual({
    root: "/media",
    path: "staging/run/a.png",
  });
  expect(place("/game", "/media", "canvas/inputs")).toEqual({ root: "/media", path: "inputs" });
  expect(place("/game", "/media", "canvas/boards/main.json")).toEqual({
    root: "/game",
    path: "canvas/boards/main.json",
  });
  expect(place("/game", "/media", "canvas/stagingx/a.png").root).toBe("/game");
  const lease = { baseUrl: "https://b/game/", mediaBaseUrl: "https://b/media/" };
  expect(previewUrl(lease, "canvas/staging/run/a b.png")).toBe(
    "https://b/media/staging/run/a%20b.png",
  );
  expect(previewUrl(lease, "Assets/hero.png")).toBe("https://b/game/Assets/hero.png");
  // A lease from before the move serves media from the checkout.
  expect(previewUrl({ baseUrl: "https://b/game" }, "canvas/staging/a.png")).toBe(
    "https://b/game/canvas/staging/a.png",
  );
});

test("a checkout's media moves to its own folder; old copies stay for readers, then go", async () => {
  const [root, data] = [await folder(), await folder()];
  await put(root, "canvas/staging/run/a.png", "a", { old: true });
  await put(root, "canvas/staging/run/b.png", "b", { old: true });
  await put(root, "canvas/staging/run/c.png", "c", { old: true });
  await put(root, "canvas/inputs/x.png", "x", { old: true });
  await put(root, "canvas/boards/main.json", "{}");
  const media = new Media(data);
  expect(await media.state(root)).toMatchObject({ kind: "legacy", dir: join(root, "canvas") });

  const start = Date.now();
  const moved = await media.migrate(root, { ...idle, now: () => start });
  const marker = (await media.marker(root))!;
  const dir = join(data, "media", marker.id);
  expect(marker.switched).toBe(true);
  expect(moved).toMatchObject({ kind: "moved", dir });
  expect(await read(dir, "staging/run/a.png")).toBe("a");
  expect(await read(dir, "inputs/x.png")).toBe("x");
  expect(await read(root, `canvas/staging/${MOVED_NOTE}`)).toBe(`Moved to ${dir}`);
  // Boards stay; the old copies wait out readers that resolved the old folder.
  expect(await read(root, "canvas/boards/main.json")).toBe("{}");
  expect(await read(root, "canvas/staging/run/a.png")).toBe("a");

  // A run told the old path writes there; its files move in, even one copied in with an old
  // modification time, and one saved again over its copy. One both folders changed stays.
  await put(root, "canvas/staging/run/late.png", "late");
  await put(root, "canvas/staging/run/kept-time.png", "kept", { old: true });
  await put(root, "canvas/staging/run/b.png", "edited");
  await put(root, "canvas/staging/run/c.png", "old folder");
  await put(dir, "staging/run/c.png", "media folder");
  await media.migrate(root, { ...idle, now: () => start + 1 });
  expect(await read(dir, "staging/run/late.png")).toBe("late");
  expect(await read(dir, "staging/run/kept-time.png")).toBe("kept");
  expect(await gone(root, "canvas/staging/run/late.png")).toBe(true);
  expect(await read(dir, "staging/run/b.png")).toBe("edited");
  expect(await gone(root, "canvas/staging/run/b.png")).toBe(true);
  expect(await read(root, "canvas/staging/run/a.png")).toBe("a");

  await media.migrate(root, { ...idle, now: () => start + LEGACY_GRACE_MS });
  expect(await gone(root, "canvas/staging/run/a.png")).toBe(true);
  expect(await gone(root, "canvas/inputs/x.png")).toBe(true);
  expect(await read(dir, "staging/run/a.png")).toBe("a");
  // Nothing unrecorded is deleted or written over.
  expect(await read(root, "canvas/staging/run/c.png")).toBe("old folder");
  expect(await read(dir, "staging/run/c.png")).toBe("media folder");
  expect(await read(dir, "staging/run/b.png")).toBe("edited");
  expect(await read(root, `canvas/staging/${MOVED_NOTE}`)).toBe(`Moved to ${dir}`);
});

test("media waits while a run may still write where it was told to", async () => {
  const [root, data] = [await folder(), await folder()];
  await put(root, "canvas/staging/run/a.png", "a");
  const media = new Media(data);
  const state = await media.migrate(root, { ...idle, busy: async () => true });
  expect(state.kind).toBe("legacy");
  expect(await gone(data, "media")).toBe(true);
});

test("a renamed checkout keeps its media; a copy forks it; a new one at the path starts over", async () => {
  const [parent, data] = [await folder(), await folder()];
  const media = new Media(data);
  const first = join(parent, "first");
  await put(first, "canvas/staging/run/a.png", "a");
  await media.migrate(first, idle);
  const dir = await media.dir(first);

  const renamed = join(parent, "renamed");
  await rename(first, renamed);
  expect(await media.state(renamed)).toMatchObject({ kind: "moved", dir });
  expect(await media.migrate(renamed, idle)).toMatchObject({ kind: "moved", dir });

  // A new checkout where the first was does not inherit its media.
  await put(first, "canvas/staging/up/new.png", "new");
  expect(await media.state(first)).toMatchObject({ kind: "legacy" });
  const fresh = await media.migrate(first, idle);
  expect(fresh.dir).not.toBe(dir);
  expect(await read(fresh.dir, "staging/up/new.png")).toBe("new");
  expect(await gone(fresh.dir, "staging/run/a.png")).toBe(true);

  // A copy writes in its own folder until its first collection forks the original's media,
  // keeping what it wrote; it never writes or frees the original's.
  const copy = join(parent, "copy");
  await cp(renamed, copy, { recursive: true });
  expect(await media.state(copy)).toMatchObject({ kind: "copied", dir: join(copy, "canvas") });
  await put(copy, "canvas/staging/run/a.png", "copy's own");
  await put(copy, "canvas/staging/run/b.png", "b");
  const runner = new GenerationRunner(undefined, media);
  runners.push(runner);
  await put(copy, "canvas/index.json", JSON.stringify({ boards: [], documents: [] }));
  const result = await collectCanvas(copy, nodeDisk, runner, media, { note: "" });
  expect(result.skipped).toBeUndefined();
  const fork = await media.state(copy);
  expect(fork).toMatchObject({ kind: "moved" });
  expect(fork.dir).not.toBe(dir);
  expect(await read(fork.dir, "staging/run/a.png")).toBe("copy's own");
  expect(await read(fork.dir, "staging/run/b.png")).toBe("b");
  expect(await read(dir, "staging/run/a.png")).toBe("a");
  expect(await gone(dir, "staging/run/b.png")).toBe(true);
  expect(await media.state(renamed)).toMatchObject({ kind: "moved", dir });
});

test("a copy taken while a move is pending moves into a folder of its own", async () => {
  const [parent, data] = [await folder(), await folder()];
  const media = new Media(data);
  const root = join(parent, "root");
  await put(root, "canvas/staging/run/a.png", "a");
  let checks = 0;
  await media.migrate(root, { ...idle, busy: async () => checks++ > 0 });
  const pending = (await media.marker(root))!;
  expect(pending.switched).toBe(false);

  const copy = join(parent, "copy");
  await cp(root, copy, { recursive: true });
  await put(copy, "canvas/staging/run/a.png", "copy");
  const copied = await media.migrate(copy, idle);
  expect(copied.dir).not.toBe(join(data, "media", pending.id));
  expect(await read(copied.dir, "staging/run/a.png")).toBe("copy");
  const original = await media.migrate(root, idle);
  expect(original.dir).toBe(join(data, "media", pending.id));
  expect(await read(original.dir, "staging/run/a.png")).toBe("a");
});

test("a slow move stops at its budget, keeps its progress, and goes on at the next pass", async () => {
  const [root, data] = [await folder(), await folder()];
  for (const name of ["a", "b", "c"]) await put(root, `canvas/staging/run/${name}.png`, name);
  const media = new Media(data);
  let clock = 0;
  // Each file's step reads the clock once; two fit.
  const state = await media.migrate(root, { ...idle, now: () => clock++, budgetMs: 2 });
  expect(state.kind).toBe("legacy");
  const dir = join(data, "media", (await media.marker(root))!.id);
  expect(Object.keys(JSON.parse(await read(dir, "copied.json")))).toHaveLength(2);
  expect(await media.migrate(root, idle)).toMatchObject({ kind: "moved", dir });
  expect(await read(dir, "staging/run/c.png")).toBe("c");
});

test("a move that stopped part way copies again what changed, and repairs its markers", async () => {
  const [root, data] = [await folder(), await folder()];
  await put(root, "canvas/staging/run/a.png", "first", { old: true });
  const media = new Media(data);
  // The copy ran, then a run started before the switch.
  let checks = 0;
  const state = await media.migrate(root, { ...idle, busy: async () => checks++ > 0 });
  expect(state.kind).toBe("legacy");
  const dir = join(data, "media", (await media.marker(root))!.id);
  expect(await read(dir, "staging/run/a.png")).toBe("first");
  // Edited in place to the same size before the move resumes.
  await put(root, "canvas/staging/run/a.png", "again");
  expect(await media.migrate(root, idle)).toMatchObject({ kind: "moved", dir });
  expect(await read(dir, "staging/run/a.png")).toBe("again");

  // A crash after the switch, before the marker said so, is repaired by the next pass.
  await writeFile(
    join(root, "canvas/staging/.moved"),
    JSON.stringify({ ...(await media.marker(root)), switched: false }),
  );
  await rm(join(root, `canvas/staging/${MOVED_NOTE}`));
  expect((await media.state(root)).kind).toBe("moved");
  await media.migrate(root, idle);
  expect((await media.marker(root))!.switched).toBe(true);
  expect(await read(root, `canvas/staging/${MOVED_NOTE}`)).toBe(`Moved to ${dir}`);
});

test("a run that reserves during a move holds off its switch", async () => {
  const [root, data] = [await folder(), await folder()];
  await put(root, "canvas/staging/run/a.png", "a");
  await put(root, "canvas/index.json", JSON.stringify({ boards: [], documents: [] }));
  const media = new Media(data);
  const runner = new GenerationRunner(undefined, media);
  runners.push(runner);
  await runner.start({
    rootPath: root,
    jobId: "agent-run",
    threadId: null,
    request: mediaRequest.parse({ kind: "agent", prompt: "Clean up" }),
  });
  // Its thread is not confirmed yet, so it may still start with the old folder.
  await collectCanvas(root, nodeDisk, runner, media, { note: "" });
  expect((await media.state(root)).kind).toBe("legacy");
  // An open request holds it off until the agent closes it, even while its thread sits idle
  // waiting for the user; so does the game's own thread at work.
  const request = { id: "request", threadId: "thread", status: "running", createdAt: Date.now() };
  await put(root, "canvas/requests/request.json", JSON.stringify(request));
  await rm(join(root, "canvas/jobs/agent-run.json"));
  await collectCanvas(root, nodeDisk, runner, media, { note: "", settled: ["thread"] });
  expect((await media.state(root)).kind).toBe("legacy");
  await put(root, "canvas/requests/request.json", JSON.stringify({ ...request, status: "done" }));
  await collectCanvas(root, nodeDisk, runner, media, { note: "", hold: true });
  expect((await media.state(root)).kind).toBe("legacy");
  await collectCanvas(root, nodeDisk, runner, media, { note: "" });
  expect((await media.state(root)).kind).toBe("moved");
});

test("a moved checkout whose media folder is gone collects nothing and keeps its catalog", async () => {
  const [root, data] = [await folder(), await folder()];
  await put(root, "canvas/staging/run/a.png", "a");
  await put(root, "canvas/index.json", JSON.stringify({ boards: [], documents: [] }));
  await put(
    root,
    "canvas/assets.json",
    JSON.stringify({ version: 1, assets: { a: { name: "a", path: "canvas/staging/run/a.png" } } }),
  );
  const media = new Media(data);
  const runner = new GenerationRunner(undefined, media);
  runners.push(runner);
  await media.migrate(root, idle);
  await rm(join(data, "media"), { recursive: true, force: true });
  expect((await media.state(root)).kind).toBe("lost");
  const result = await collectCanvas(root, nodeDisk, runner, media, { note: "" });
  expect(result).toMatchObject({ deleted: [], missing: [] });
  expect(result.skipped).toContain("missing");
});

test("runs of a moved checkout write and read their files in the media folder", async () => {
  const [root, data] = [await folder(), await folder()];
  const media = new Media(data);
  await media.migrate(root, idle);
  const dir = await media.dir(root);
  const runner = new GenerationRunner(async (command) => {
    if (command.args[0] === "doctor") return { code: 0, stdout: "{}", stderr: "" };
    if (command.args[0] === "imagine")
      return {
        code: 0,
        stdout: JSON.stringify({
          success: [{ job_id: "c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8" }],
          failure: [],
        }),
        stderr: "",
      };
    const out = command.args[command.args.indexOf("--output") + 1]!;
    for (let index = 0; index < 4; index++) await writeFile(join(out, `${index}.png`), "png");
    return { code: 0, stdout: "{}", stderr: "" };
  }, media);
  runners.push(runner);
  const target = { rootPath: root, jobId: "moved-run" };
  await runner.start({
    ...target,
    threadId: null,
    request: mediaRequest.parse({
      kind: "image",
      prompt: "A key",
      model: { provider: "midjourney" },
    }),
  });
  let job = await runner.status(target);
  for (let attempt = 0; ["queued", "running"].includes(job.status) && attempt < 200; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = await runner.status(target);
  }
  expect(job.status).toBe("succeeded");
  expect(job.outputs.map(({ path }) => path)).toEqual(
    [0, 1, 2, 3].map((index) => `canvas/staging/moved-run/${index}.png`),
  );
  expect(await read(dir, "staging/moved-run/0.png")).toBe("png");
  expect(await gone(root, "canvas/staging/moved-run")).toBe(true);

  // An agent told the old path writes there; its run collects those files too.
  const agent = { rootPath: root, jobId: "agent-run" };
  await runner.start({
    ...agent,
    threadId: null,
    request: mediaRequest.parse({ kind: "agent", prompt: "Clean up the mesh" }),
  });
  await put(root, "canvas/staging/agent-run/old-path.png", "old");
  await put(dir, "staging/agent-run/clean.glb", "glb");
  const outputs = await runner.stagedOutputs(agent);
  expect(outputs.map(({ path }) => path)).toEqual([
    "canvas/staging/agent-run/clean.glb",
    "canvas/staging/agent-run/old-path.png",
  ]);
  expect(await read(dir, "staging/agent-run/old-path.png")).toBe("old");
});

test("collecting a moved checkout frees and checks files in its media folder", async () => {
  const [root, data] = [await folder(), await folder()];
  const unused = `canvas/inputs/${"a".repeat(64)}.png`;
  await put(root, unused, "input", { old: true });
  await put(root, "canvas/staging/up/kept.png", "kept", { old: true });
  await put(root, "canvas/index.json", JSON.stringify({ boards: [], documents: [] }));
  await put(
    root,
    "canvas/assets.json",
    JSON.stringify({
      version: 1,
      assets: {
        kept: { name: "kept", path: "canvas/staging/up/kept.png" },
        lost: { name: "lost", path: "canvas/staging/up/lost.png" },
      },
    }),
  );
  const media = new Media(data);
  const runner = new GenerationRunner(undefined, media);
  runners.push(runner);
  // The first pass moves the media, then collects from its new folder.
  const result = await collectCanvas(root, nodeDisk, runner, media, { note: "" });
  const dir = await media.dir(root);
  expect(dir).toBe(join(data, "media", (await media.marker(root))!.id));
  expect(result.deleted).toEqual([unused]);
  expect(await gone(dir, `inputs/${"a".repeat(64)}.png`)).toBe(true);
  expect(result.missing).toEqual(["canvas/staging/up/lost.png"]);
  expect(await read(dir, "staging/up/kept.png")).toBe("kept");
});
