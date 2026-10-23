import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GenerationJob } from "../shared/generation.ts";
import { nodeDisk, removeStaleSnapshot } from "./canvas.ts";
import {
  collectCanvas,
  decide,
  GRACE_MS,
  UNUSED_MS,
  type Context,
  type References,
} from "./collect.ts";
import { GenerationRunner } from "./generation.ts";
import { Media } from "./media.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const now = 1_800_000_000_000;
const old = now - 10 * GRACE_MS;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const id = (path: string) => sha(path).slice(0, 32);

function job(jobId: string, fields: Partial<GenerationJob> = {}): GenerationJob {
  return {
    version: 1,
    id: jobId,
    threadId: null,
    origin: { kind: "canvas", gameId: "game" },
    createdAt: old,
    updatedAt: old,
    status: "succeeded",
    request: {
      kind: "image",
      prompt: "A lighthouse",
      model: { provider: "google", id: "gemini-nano-banana-2.1" },
      images: [],
      aspectRatio: "1:1",
      transparentBackground: false,
      resolution: "1K",
    },
    target: { boardId: "main", nodeId: "hero", fingerprint: "f" },
    outputs: [1, 2].map((n) => ({
      path: `canvas/staging/${jobId}/output-${n}.png`,
      type: "image" as const,
      sizeBytes: 1,
      sha256: sha(`${jobId}-${n}`),
    })),
    ...fields,
  };
}

function context(
  item: GenerationJob,
  {
    names = [] as string[],
    retired = [] as string[],
    nodes = ["main\0hero"],
    jobs = [item],
    orphaned = false,
  } = {},
): Context {
  const refs: References = {
    names: new Set(names),
    documents: "",
    nodes: new Set(nodes),
    catalog: new Map(jobs.flatMap(({ outputs }) => outputs.map(({ path }) => [path, id(path)]))),
  };
  return {
    jobs,
    refs,
    retired: new Set(retired),
    folder: item.outputs.map(({ path }) => path),
    orphaned,
    now,
  };
}

test("collection frees only outputs the retention rule retired and nothing names", () => {
  const run = job("run");
  const [first, second] = run.outputs.map(({ path }) => path) as [string, string];
  expect(decide(run, context(run, { retired: [first, second] }))).toEqual({ kind: "delete" });
  expect(decide(run, context(run, { retired: [first] }))).toEqual({
    kind: "trim",
    outputs: [run.outputs[1]!],
  });
  // A retired take that something links again stays.
  expect(decide(run, context(run, { retired: [first], names: [id(first)] }))).toEqual({
    kind: "keep",
  });
  // Outputs that never reached a node, or left it by hand, stay in the library.
  expect(decide(run, context(run))).toEqual({ kind: "keep" });
  // Running, uncertain, agent-requested and recent jobs stay.
  for (const kept of [
    { ...run, status: "running" as const },
    { ...run, status: "uncertain" as const },
    { ...run, target: undefined },
    { ...run, updatedAt: now - GRACE_MS + 1 },
  ])
    expect(decide(kept, context(kept, { retired: [first, second] }))).toEqual({ kind: "keep" });
  // A file an agent left beside the outputs, which a document names, keeps the folder.
  const folder = { ...context(run, { retired: [first, second] }) };
  folder.folder = [...folder.folder, "canvas/staging/run/report.md"];
  folder.refs.documents = "See canvas/staging/run/report.md";
  expect(decide(run, folder)).toEqual({ kind: "trim", outputs: [] });
});

test("a deleted node's generations wait for their timers, and a failure for a later success", () => {
  const run = job("run");
  const [first, second] = run.outputs.map(({ path }) => path) as [string, string];
  expect(decide(run, context(run, { nodes: [] }))).toEqual({ kind: "keep" });
  // Once its node has been gone a week, a failure goes too.
  const gone = job("gone", { status: "failed", outputs: [] });
  expect(decide(gone, context(gone, { nodes: [] }))).toEqual({ kind: "keep" });
  expect(decide(gone, context(gone, { nodes: [], orphaned: true }))).toEqual({ kind: "delete" });
  // A node restored since the clock ran out keeps its failure.
  expect(decide(gone, context(gone, { orphaned: true }))).toEqual({ kind: "keep" });
  // A take the rule retired still goes after its node is deleted.
  expect(decide(run, context(run, { nodes: [], retired: [first, second] }))).toEqual({
    kind: "delete",
  });
  const failure = job("failure", { status: "failed", outputs: [] });
  const later = job("later", { createdAt: old + 1 });
  expect(decide(failure, context(failure))).toEqual({ kind: "keep" });
  expect(decide(failure, context(failure, { jobs: [failure, later] }))).toEqual({
    kind: "delete",
  });
  // A provider task that can still be resumed keeps its record, however superseded.
  for (const resumable of [
    { ...failure, taskId: "task" },
    { ...failure, status: "auth-required" as const, taskId: "task" },
  ])
    expect(decide(resumable, context(resumable, { jobs: [resumable, later] }))).toEqual({
      kind: "keep",
    });
  // A failed BB text run has no paid task; its thread was all it had.
  const text = job("text", {
    status: "failed",
    taskId: "thr_text",
    outputs: [],
    request: {
      kind: "text",
      prompt: "Review",
      model: { provider: "bb", id: "default" },
      images: [],
      outputCount: 1,
    },
  });
  expect(decide(text, context(text, { jobs: [text, later] }))).toEqual({ kind: "delete" });
});

test("a review stays while its takes or its record remain on the node", () => {
  const judged = id("canvas/staging/run/output-1.png");
  const review = job("review", {
    request: {
      kind: "text",
      prompt: "Review",
      model: { provider: "bb", id: "default" },
      images: [],
      outputCount: 1,
      reviewOf: [judged],
    },
    outputs: [
      { path: "canvas/staging/review/output.md", type: "text", sizeBytes: 1, sha256: sha("r") },
    ],
  });
  expect(decide(review, context(review, { names: [judged] }))).toEqual({ kind: "keep" });
  expect(decide(review, context(review, { names: ["review"] }))).toEqual({ kind: "keep" });
  expect(decide(review, context(review))).toEqual({ kind: "delete" });
});

async function canvas(board: unknown, jobs: GenerationJob[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-collect-")));
  roots.push(root);
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await put(
    "canvas/index.json",
    JSON.stringify({ version: 1, boards: [{ id: "main" }], documents: [] }),
  );
  await put("canvas/boards/main.json", JSON.stringify(board));
  const assets: Record<string, { name: string; path: string }> = {};
  for (const item of jobs) {
    await put(`canvas/jobs/${item.id}.json`, JSON.stringify(item));
    for (const output of item.outputs) {
      await put(output.path, "bytes");
      assets[id(output.path)] = { name: "output.png", path: output.path };
    }
  }
  await put("canvas/assets.json", JSON.stringify({ version: 1, assets }));
  return { root, put };
}

const takesOf = (runs: GenerationJob[]) =>
  runs.flatMap((run) => run.outputs.map(({ path }) => ({ assetId: id(path), jobId: run.id })));

test("collection trims a node to its newest five runs and frees what they retired", async () => {
  const runs = Array.from({ length: 9 }, (_, n) => job(`run-${n}`, { createdAt: old + n }));
  const takes = takesOf(runs);
  // A take from before runs existed is retired by its file's job.
  takes[0] = { ...takes[0]!, jobId: "" };
  const pick = takes[1]!.assetId;
  // Another node links one retired take from the library; it stays.
  const linked = takes[2]!.assetId;
  const { root, put } = await canvas(
    {
      nodes: [
        { id: "hero", data: { assetId: pick, takes } },
        { id: "poster", data: { images: [{ type: "library", assetId: linked }] } },
      ],
    },
    runs,
  );
  // An agent's hidden working file, which a document names, keeps its folder.
  const source = "canvas/staging/run-2/.source/model.blend";
  await put(source, "blend");
  await put(
    "canvas/index.json",
    JSON.stringify({ boards: [{ id: "main" }], documents: [{ id: "design" }] }),
  );
  await put("canvas/documents/design.md", `Built from ${source}.`);
  const unused = `canvas/inputs/${sha("unused")}.png`;
  await put(unused, "input");
  await utimes(join(root, unused), old / 1000, old / 1000);
  const runner = new GenerationRunner();

  const first = await collectCanvas(root, nodeDisk, runner, new Media(), { note: "", now });

  const board = JSON.parse(await readFile(join(root, "canvas/boards/main.json"), "utf8"));
  expect(board.nodes[0].data.takes).toEqual([takes[1], ...takes.slice(8)]);
  // Retired takes stay in the library for a while, so linking one again keeps it.
  expect(first.deleted).toEqual([unused]);
  expect(await readdir(join(root, "canvas/staging"))).toHaveLength(9);

  const result = await collectCanvas(root, nodeDisk, runner, new Media(), {
    note: "",
    now: now + GRACE_MS + 1,
  });

  expect(result.deleted.sort()).toEqual(
    [
      runs[0]!.outputs[0]!.path,
      runs[1]!.outputs[1]!.path,
      ...runs[2]!.outputs.map(({ path }) => path),
      ...runs[3]!.outputs.map(({ path }) => path),
    ].sort(),
  );
  expect(await readdir(join(root, "canvas/staging/run-1"))).toEqual(["output-1.png"]);
  expect(await readdir(join(root, "canvas/staging/run-2"), { recursive: true })).toEqual([
    ".source",
    ".source/model.blend",
  ]);
  expect((await runner.records(root)).map(({ id: jobId }) => jobId).sort()).toEqual(
    runs.map(({ id: jobId }) => jobId).filter((jobId) => jobId !== "run-3"),
  );
  // The retired run's request ID never submits again, and its status says why.
  await expect(
    runner.start({ rootPath: root, jobId: "run-3", threadId: null, request: runs[3]!.request }),
  ).rejects.toThrow("Choose a new request ID");
  expect(await runner.reconcileMissing({ rootPath: root, jobId: "run-3" })).toEqual({
    missing: true,
    pruned: true,
  });
  // Nothing left to free: the ledger keeps only what the library link holds back.
  const ledger = JSON.parse(await readFile(join(root, "canvas/jobs/.retired.json"), "utf8"));
  expect(ledger.retired).toEqual([{ assetId: linked, jobId: "run-1", at: now }]);
  expect(ledger.unused).toEqual({});
  expect(result.missing).toEqual([]);
});

test("a take removed by hand goes a week after anything last named it", async () => {
  const run = job("run");
  const [kept, cleared] = run.outputs.map(({ path }) => path) as [string, string];
  const pick = { assetId: id(kept), takes: [{ assetId: id(kept), jobId: "run" }] };
  const { root, put } = await canvas({ nodes: [{ id: "hero", data: pick }] }, [run]);
  const day = 24 * GRACE_MS;
  const runner = new GenerationRunner();
  const pass = async (at: number) =>
    (await collectCanvas(root, nodeDisk, runner, new Media(), { note: "", now: at })).deleted;
  // The first pass starts its clock.
  expect(await pass(now)).toEqual([]);
  // A document links it on day three, and drops the link on day four.
  await put(
    "canvas/index.json",
    JSON.stringify({ boards: [{ id: "main" }], documents: [{ id: "design" }] }),
  );
  await put("canvas/documents/design.md", `Uses ${cleared}.`);
  expect(await pass(now + 3 * day)).toEqual([]);
  await put("canvas/documents/design.md", "No links.");
  expect(await pass(now + 4 * day)).toEqual([]);
  expect(await pass(now + UNUSED_MS + 1)).toEqual([]);
  expect(await pass(now + 4 * day + UNUSED_MS)).toEqual([cleared]);
  expect(await readdir(join(root, "canvas/staging/run"))).toEqual(["output-1.png"]);
});

test("an output that never reached its live node keeps its files", async () => {
  const first = job("first");
  const { root, put } = await canvas({ nodes: [{ id: "hero", data: {} }] }, [first]);
  const runner = new GenerationRunner();
  // The first pass counts what is already there; a later one only what was named.
  await collectCanvas(root, nodeDisk, runner, new Media(), { note: "", now });
  const late = job("late", { createdAt: now, updatedAt: now });
  await put("canvas/jobs/late.json", JSON.stringify(late));
  for (const { path } of late.outputs) await put(path, "bytes");
  const assets = JSON.parse(await readFile(join(root, "canvas/assets.json"), "utf8"));
  for (const { path } of late.outputs) assets.assets[id(path)] = { name: "output.png", path };
  await put("canvas/assets.json", JSON.stringify(assets));
  const result = await collectCanvas(root, nodeDisk, runner, new Media(), {
    note: "",
    now: now + 2 * UNUSED_MS,
  });
  expect(result.deleted.sort()).toEqual(first.outputs.map(({ path }) => path).sort());
  expect((await readdir(join(root, "canvas/staging/late"))).sort()).toEqual([
    "output-1.png",
    "output-2.png",
  ]);
});

test("a deleted node that comes back starts its clock over", async () => {
  const run = job("run");
  const takes = run.outputs.map(({ path }) => ({ assetId: id(path), jobId: "run" }));
  const node = { id: "hero", data: { assetId: takes[0]!.assetId, takes } };
  const { root, put } = await canvas({ nodes: [node] }, [run]);
  const runner = new GenerationRunner();
  const day = 24 * GRACE_MS;
  const pass = async (at: number) =>
    (await collectCanvas(root, nodeDisk, runner, new Media(), { note: "", now: at })).deleted;
  await pass(now);
  await put("canvas/boards/main.json", JSON.stringify({ nodes: [] }));
  expect(await pass(now + day)).toEqual([]);
  // Undone on day five, deleted again on day six.
  await put("canvas/boards/main.json", JSON.stringify({ nodes: [node] }));
  expect(await pass(now + 5 * day)).toEqual([]);
  await put("canvas/boards/main.json", JSON.stringify({ nodes: [] }));
  expect(await pass(now + 6 * day)).toEqual([]);
  expect(await pass(now + day + UNUSED_MS)).toEqual([]);
  expect((await pass(now + 6 * day + UNUSED_MS)).sort()).toEqual(
    run.outputs.map(({ path }) => path).sort(),
  );
});

test("the catalog hears about staged files already gone", async () => {
  const run = job("run");
  const { root } = await canvas({ nodes: [{ id: "hero", data: {} }] }, [run]);
  await rm(join(root, run.outputs[1]!.path));
  const result = await collectCanvas(root, nodeDisk, new GenerationRunner(), new Media(), {
    note: "",
    now,
  });
  expect(result).toEqual({ deleted: [], missing: [run.outputs[1]!.path] });
});

test("an unreadable board stops collection before anything is deleted", async () => {
  const runs = Array.from({ length: 7 }, (_, n) => job(`run-${n}`, { createdAt: old + n }));
  const { root, put } = await canvas(
    { nodes: [{ id: "hero", data: { takes: takesOf(runs) } }] },
    runs,
  );
  await put("canvas/boards/main.json", "{ not json");
  await expect(
    collectCanvas(root, nodeDisk, new GenerationRunner(), new Media(), { note: "", now }),
  ).rejects.toThrow();
  expect(await readdir(join(root, "canvas/staging"))).toHaveLength(7);
});

test("a snapshot a dispatch reuses is new again, so collection keeps it", async () => {
  const { root, put } = await canvas({ nodes: [] }, []);
  await put("refs/hero.png", "png");
  const file = (await nodeDisk.read(root, "refs/hero.png"))!;
  const snapshot = `canvas/inputs/${file.sha256}.png`;
  await nodeDisk.copy(root, "refs/hero.png", root, snapshot, file);
  await utimes(join(root, snapshot), 1, 1);
  // The dispatch reuses it just before collection looks.
  expect(await nodeDisk.copy(root, "refs/hero.png", root, snapshot, file)).toBe(false);
  expect(await removeStaleSnapshot(root, snapshot, Date.now() - GRACE_MS)).toBe(false);
  await utimes(join(root, snapshot), 1, 1);
  expect(await removeStaleSnapshot(root, snapshot, Date.now() - GRACE_MS)).toBe(true);
});
