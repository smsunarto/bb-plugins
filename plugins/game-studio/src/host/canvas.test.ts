import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExperimentalHostWatchListener,
  ExperimentalHostWatchOptions,
} from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "./host.ts";

const roots: string[] = [];
const harnesses: { experimental_dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.experimental_dispose()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const board = (id: string) =>
  `${JSON.stringify({ version: 1, id, viewport: { width: 1280, height: 720 }, nodes: [], edges: [] })}\n`;

async function project() {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "studio-canvas-host-")));
  roots.push(rootPath);
  const seed = async (path: string, content: string | Buffer) => {
    await mkdir(dirname(join(rootPath, path)), { recursive: true });
    await writeFile(join(rootPath, path), content);
  };
  await seed(
    "canvas/index.json",
    JSON.stringify({
      version: 1,
      mainDocumentId: "design",
      boards: [{ id: "main", name: "Design board" }],
      documents: [{ id: "design", title: "Design" }],
    }),
  );
  await seed("canvas/boards/main.json", board("main"));
  await seed("canvas/documents/design.md", "# Orbit\n");
  await seed("canvas/assets.json", JSON.stringify({ version: 1, assets: {} }));
  await seed("assets/hero.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const watches: {
    options: ExperimentalHostWatchOptions;
    listener: ExperimentalHostWatchListener;
  }[] = [];
  const disposed: string[] = [];
  const harness = experimental_createHostEntryHarness(entry, {
    experimental_watch: (options, listener) => {
      watches.push({ options, listener });
      return { dispose: async () => void disposed.push(options.rootPath) };
    },
  });
  harnesses.push(harness);
  const read = (input: { since?: string; watch?: boolean } = {}) =>
    harness.experimental_call("readCanvas", {
      rootPath,
      kind: "general",
      ...(input.since ? { since: input.since } : {}),
      ...(input.watch ? { watch: { gameId: "orbit" } } : {}),
    });
  return { rootPath, seed, harness, read, watches, disposed };
}

/** Lets a watch check that a change event queued run to its end. */
async function settled(check: () => boolean = () => false) {
  for (let attempt = 0; attempt < 50 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

test("an unchanged canvas answers with its fingerprint alone, and a change sends only what changed", async () => {
  const f = await project();
  const first = await f.read();
  if (first.status !== "changed") throw new Error("The first read must carry the canvas");
  expect(first.base).toBeNull();
  expect(first.entries["file:canvas/documents/design.md"]).toMatchObject({
    kind: "file",
    file: { content: "# Orbit\n", contentEncoding: "utf8", sha256: sha256("# Orbit\n") },
  });
  expect(first.entries["list:assets"]).toEqual({
    kind: "listing",
    files: ["assets/hero.png"],
    truncated: false,
  });
  expect(first.entries["file:canvas/editor/main.json"]).toEqual({ kind: "missing" });

  expect(await f.read({ since: first.fingerprint })).toEqual({
    status: "unchanged",
    fingerprint: first.fingerprint,
  });

  await f.seed("canvas/documents/design.md", "# Orbit\nCollect stars.\n");
  const second = await f.read({ since: first.fingerprint });
  if (second.status !== "changed") throw new Error("An edit must change the canvas");
  expect(second.base).toBe(first.fingerprint);
  expect(Object.keys(second.entries)).toEqual(["file:canvas/documents/design.md"]);
  expect(second.removed).toEqual([]);
  // A base the host no longer remembers gets the whole canvas.
  const unknown = await f.read({ since: "forgotten" });
  expect(unknown).toMatchObject({ status: "changed", base: null });
});

test("reads never wake the watch they lease; a change on disk signals once with its new hash", async () => {
  const f = await project();
  const first = await f.read({ watch: true });
  expect(f.watches.map(({ options }) => options.rootPath).sort()).toEqual([
    join(f.rootPath, "assets"),
    join(f.rootPath, "canvas"),
  ]);
  const canvas = f.watches.find(({ options }) => options.rootPath.endsWith("canvas"))!;
  expect(canvas.options.ignoredPaths).toEqual(["inputs"]);

  // The studio reads again, as its safety poll and every signal make it do.
  await f.read({ watch: true, since: first.fingerprint });
  await f.read({ watch: true });
  // Churn that changes no entry: a temporary file and an input snapshot.
  await f.seed("canvas/boards/main.json.1234.tmp", "partial");
  await f.seed("canvas/inputs/abc.png", "snapshot");
  await canvas.listener({
    kind: "changed",
    changes: [{ path: join(f.rootPath, "canvas/boards/main.json.1234.tmp"), type: "create" }],
  });
  await canvas.listener({ kind: "rescan-required" });
  await settled();
  expect(f.harness.experimental_getSignals()).toEqual([]);
  // A second watched read leases the same watch instead of arming another.
  expect(f.watches).toHaveLength(2);

  await f.seed("canvas/boards/main.json", board("main").replace("1280", "1920"));
  await canvas.listener({
    kind: "changed",
    changes: [{ path: join(f.rootPath, "canvas/boards/main.json"), type: "update" }],
  });
  await settled(() => f.harness.experimental_getSignals().length > 0);
  expect(f.harness.experimental_getSignals()).toEqual([
    {
      signal: "canvasChanged",
      payload: {
        gameId: "orbit",
        changes: [
          {
            path: "canvas/boards/main.json",
            sha256: sha256(board("main").replace("1280", "1920")),
          },
        ],
      },
    },
  ]);
  // The same state seen again is not a second change.
  await canvas.listener({ kind: "rescan-required" });
  await settled();
  expect(f.harness.experimental_getSignals()).toHaveLength(1);
});

test("a write before a new watch goes live is still said once it does", async () => {
  const f = await project();
  let live = () => {};
  const started = new Promise<void>((resolve) => (live = resolve));
  const harness = experimental_createHostEntryHarness(entry, {
    experimental_watch: async () => {
      await started;
      return { dispose: async () => undefined };
    },
  });
  harnesses.push(harness);
  await harness.experimental_call("readCanvas", {
    rootPath: f.rootPath,
    kind: "general",
    watch: { gameId: "orbit" },
  });
  // An agent writes the board after the read looked, before the daemon watches.
  await f.seed("canvas/boards/main.json", board("main").replace("[]", '[{"id":"n"}]'));
  live();
  await settled(() => harness.experimental_getSignals().length > 0);
  expect(harness.experimental_getSignals()).toEqual([
    expect.objectContaining({
      signal: "canvasChanged",
      payload: expect.objectContaining({ gameId: "orbit" }),
    }),
  ]);
});

test("concurrent watched reads arm each folder once, and disposal closes every watch", async () => {
  const f = await project();
  await Promise.all([f.read({ watch: true }), f.read({ watch: true }), f.read({ watch: true })]);
  const watched = f.watches.map(({ options }) => options.rootPath).sort();
  expect(watched.length).toBeGreaterThan(0);
  expect(new Set(watched).size).toBe(watched.length);
  await f.harness.experimental_dispose();
  await settled(() => f.disposed.length >= watched.length);
  expect([...f.disposed].sort()).toEqual(watched);
});

test("a board save swaps both files only from the revision the studio edited", async () => {
  const f = await project();
  const expected = { content: sha256(board("main")), layout: null };
  const layout = `${JSON.stringify({ version: 1, view: "canvas", nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } })}\n`;
  const content = board("main").replace("720", "1080");
  const saved = await f.harness.experimental_call("saveCanvasBoard", {
    rootPath: f.rootPath,
    boardId: "main",
    expected,
    content,
    layout,
  });
  expect(saved).toEqual({ content: sha256(content), layout: sha256(layout) });
  expect(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8")).toBe(content);
  expect(await readFile(join(f.rootPath, "canvas/editor/main.json"), "utf8")).toBe(layout);
  // A save from the old revision finds the newer board and writes nothing.
  await expect(
    f.harness.experimental_call("saveCanvasBoard", {
      rootPath: f.rootPath,
      boardId: "main",
      expected,
      content: board("main"),
      layout: "{}\n",
    }),
  ).rejects.toThrow("changed on disk");
  expect(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8")).toBe(content);
  expect(await readFile(join(f.rootPath, "canvas/editor/main.json"), "utf8")).toBe(layout);
  await expect(
    f.harness.experimental_call("saveCanvasBoard", {
      rootPath: f.rootPath,
      boardId: "missing",
      expected,
      content,
      layout,
    }),
  ).rejects.toThrow("not registered");
  expect((await readdir(join(f.rootPath, "canvas/boards"))).sort()).toEqual(["main.json"]);
});

test("input capture copies image bytes beside the project and never replaces a snapshot", async () => {
  const f = await project();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
  await f.seed("refs/hero.PNG", png);
  const snapshot = `canvas/inputs/${sha256(png)}.png`;
  expect(
    await f.harness.experimental_call("captureCanvasInputs", {
      rootPath: f.rootPath,
      paths: ["refs/hero.PNG", "refs/hero.PNG"],
    }),
  ).toEqual({ inputs: [{ path: "refs/hero.PNG", snapshot, sha256: sha256(png) }] });
  expect(await readFile(join(f.rootPath, snapshot))).toEqual(png);
  // The same bytes again reuse their snapshot, which is new again so collection keeps it.
  await utimes(join(f.rootPath, snapshot), 1, 1);
  await f.harness.experimental_call("captureCanvasInputs", {
    rootPath: f.rootPath,
    paths: ["refs/hero.PNG"],
  });
  expect((await stat(join(f.rootPath, snapshot))).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  await f.seed(snapshot, "corrupt");
  await expect(
    f.harness.experimental_call("captureCanvasInputs", {
      rootPath: f.rootPath,
      paths: ["refs/hero.PNG"],
    }),
  ).rejects.toThrow("A saved generation input changed. No request was submitted.");
  expect(await readFile(join(f.rootPath, snapshot), "utf8")).toBe("corrupt");
  await f.seed("refs/notes.gif", Buffer.from([0x47, 0x49, 0x46]));
  await expect(
    f.harness.experimental_call("captureCanvasInputs", {
      rootPath: f.rootPath,
      paths: ["refs/notes.gif"],
    }),
  ).rejects.toThrow("PNG, JPEG or WebP files under 14 MiB");
});

test("a read shows an interrupted job as uncertain without rewriting its receipt", async () => {
  const f = await project();
  const receipt = `${JSON.stringify({
    version: 1,
    id: "interrupted",
    createdAt: 1,
    updatedAt: 1,
    threadId: null,
    status: "running",
    request: { kind: "image", prompt: "Hero" },
    outputs: [],
  })}\n`;
  await f.seed("canvas/jobs/interrupted.json", receipt);
  const first = await f.read({ watch: true });
  if (first.status !== "changed") throw new Error("The first read must carry the canvas");
  expect(first.entries["jobs"]).toEqual({ kind: "jobs", workspacePath: f.rootPath, stale: false });
  expect(first.entries["job:interrupted"]).toMatchObject({
    kind: "job",
    job: { status: "uncertain" },
  });
  expect(await readFile(join(f.rootPath, "canvas/jobs/interrupted.json"), "utf8")).toBe(receipt);
  // Reading again neither writes nor finds anything new.
  expect(await f.read({ watch: true, since: first.fingerprint })).toEqual({
    status: "unchanged",
    fingerprint: first.fingerprint,
  });
  expect(await readFile(join(f.rootPath, "canvas/jobs/interrupted.json"), "utf8")).toBe(receipt);
});

test("a canvas larger than one host result goes out in parts that each fit", async () => {
  const f = await project();
  const documents = ["one", "two", "three"].map((id) => ({ id, title: id }));
  await f.seed(
    "canvas/index.json",
    JSON.stringify({ version: 1, boards: [{ id: "main", name: "Design board" }], documents }),
  );
  // Three 3 MiB documents: more than the 8 MiB a host result may carry.
  const markdown = "a".repeat(3 * 1024 * 1024);
  for (const { id } of documents) await f.seed(`canvas/documents/${id}.md`, markdown);
  const held = new Map<string, unknown>();
  let since: string | undefined;
  let parts = 0;
  for (;;) {
    const read = await f.read(since ? { since } : {});
    if (read.status !== "changed") throw new Error("Each part must carry entries");
    expect(read.base).toBe(since ?? null);
    for (const [key, entry] of Object.entries(read.entries)) held.set(key, entry);
    since = read.fingerprint;
    parts += 1;
    if (!read.more) break;
  }
  expect(parts).toBeGreaterThan(1);
  for (const { id } of documents)
    expect(held.get(`file:canvas/documents/${id}.md`)).toMatchObject({
      kind: "file",
      file: { sha256: sha256(markdown) },
    });
  // The last part's fingerprint is the whole canvas's.
  expect(await f.read({ since })).toEqual({ status: "unchanged", fingerprint: since });
});
