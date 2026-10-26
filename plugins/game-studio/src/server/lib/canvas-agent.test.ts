import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { nodeDisk } from "../../host/canvas.ts";
import { canvasHostRouter } from "../../../test/canvas-host.ts";
import { loadWorkspace } from "./studio.ts";
import { canvasEditInput, canvasContextInput } from "../../shared/canvas-agent.ts";
import { editCanvas } from "./canvas-edit.ts";
import { CanvasEditStore } from "./canvas-edits.ts";
import { readCanvasContext } from "./canvas-context.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(count = 1) {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-agent-"));
  const canvas = canvasHostRouter(
    () => nodeDisk,
    async (root) => ({ workspacePath: root, jobs: [], stale: false }),
  );
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: threadId === "owner" ? "project" : "other",
            environmentId: "environment",
          }),
      },
      environments: {
        get: async () => ({ id: "environment", hostId: "host", path: rootPath }) as never,
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      calls.push(method);
      if (method === "resolveWorkspace") return { workspacePath: rootPath };
      if (canvas.handles(method)) return canvas.call(method, input, hostId);
      throw new Error(`Unexpected host call: ${method}`);
    },
  });
  await plugin(bb);
  cleanups.push(async () => {
    await harness.lifecycle.dispose();
    await rm(rootPath, { recursive: true, force: true });
  });
  const seed = async (path: string, value: unknown) =>
    writeFile(join(rootPath, path), JSON.stringify(value));
  await mkdir(join(rootPath, "canvas/boards"), { recursive: true });
  await mkdir(join(rootPath, "canvas/editor"), { recursive: true });
  await bb.storage.kv.set("game:game", {
    id: "game",
    name: "Orbit",
    projectId: "project",
    hostId: "host",
    rootPath,
    kind: "web",
    createdAt: 0,
    threadId: "owner",
  });
  await seed("canvas/index.json", {
    version: 1,
    boards: [{ id: "main", name: "Main" }],
    documents: [],
  });
  await seed("canvas/assets.json", { version: 1, assets: {} });
  await seed("canvas/boards/main.json", {
    version: 1,
    id: "main",
    viewport: { width: 1280, height: 720 },
    edges: [],
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `note${i}`,
      type: "text",
      title: `Note ${i}`,
      data: {
        text: "Original",
        takes: [{ detail: "history".repeat(500) }],
        reviews: [{ text: "review".repeat(500) }],
      },
    })),
  });
  await seed("canvas/editor/main.json", {
    version: 1,
    view: "canvas",
    nodes: { note0: { x: 740, y: 120, width: 420, height: 700 } },
    viewport: { x: 51, y: 72, zoom: 0.7 },
  });
  const snapshot = async () => (await loadWorkspace(bb, "game")).boards[0]!;
  const edit = async (operations: unknown[], options = {}) => {
    const { revision } = await snapshot();
    return editCanvas(
      bb,
      canvasEditInput.parse({ gameId: "game", boardId: "main", revision, operations, ...options }),
      { edits: new CanvasEditStore(bb.storage.database()), threadId: "owner" },
    );
  };
  return { bb, harness, calls, rootPath, snapshot, edit, seed };
}

test("context pages a large board, omits histories explicitly, and reads long fields without loss", async () => {
  const f = await fixture(65);
  const overview = await readCanvasContext(f.bb, canvasContextInput.parse({ gameId: "game" }));
  expect(overview).toMatchObject({ section: "boards", total: 1, items: [{ nodeCount: 65 }] });
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await f.harness.callAgentTool(
      "game_studio_canvas_context",
      { gameId: "game", boardId: "main", offset, limit: 50 },
      { threadId: "owner" },
    );
    if (typeof page !== "string") throw new Error("Expected JSON tool result");
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(40000);
    const parsed = JSON.parse(page);
    ids.push(...parsed.items.map((node: { id: string }) => node.id));
    expect(parsed.items[0]).toMatchObject({
      data: { text: "Original" },
      omittedDataKeys: ["takes", "reviews"],
    });
    offset = parsed.nextOffset;
  }
  expect(ids).toHaveLength(65);
  expect(new Set(ids).size).toBe(65);
  const text = 'long prompt: "\n🐈'.repeat(4000);
  await f.edit([{ op: "update_node", id: "note0", patch: { data: { text } } }]);
  const chunks: string[] = [];
  offset = 0;
  while (offset !== null) {
    const field = await readCanvasContext(
      f.bb,
      canvasContextInput.parse({
        gameId: "game",
        boardId: "main",
        field: { nodeId: "note0", key: "text", offset },
      }),
    );
    if (!("text" in field)) throw new Error("Expected field page");
    expect(Buffer.byteLength(JSON.stringify(field))).toBeLessThanOrEqual(40000);
    chunks.push(field.text);
    offset = field.nextOffset;
  }
  expect(chunks.join("")).toBe(text);
});

test("native edits build connected workflows, merge brief data and preserve outputs and layout", async () => {
  const f = await fixture();
  const initial = await f.snapshot();
  const operations = [
    {
      op: "add_node",
      node: {
        id: "concept",
        type: "image",
        title: "Concept",
        data: {
          prompt: "Urban Tokyo",
          review: { enabled: true, retries: 0 },
          judge: { enabled: true },
        },
      },
    },
    { op: "connect", id: "brief-concept", source: "note0", target: "concept", port: "text" },
    { op: "update_node", id: "note0", patch: { data: { text: "Use these references" } } },
  ];
  const result = await f.harness.callAgentTool(
    "game_studio_canvas_edit",
    { gameId: "game", boardId: "main", revision: initial.revision, operations },
    { threadId: "owner" },
  );
  expect(result).toContain('"saved":true');
  expect(result).toMatch(/"editId":"[0-9a-f-]{36}"/);
  const saved = await f.snapshot();
  expect(saved.board.nodes[0]!.data.takes).toEqual(initial.board.nodes[0]!.data.takes);
  expect(saved.board.nodes[0]!.position).toEqual({ x: 740, y: 120 });
  expect(saved.board.editorLayout.viewport).toEqual(initial.board.editorLayout.viewport);
  expect(saved.board.editorLayout.nodes.note0).toEqual(initial.board.editorLayout.nodes.note0);
  expect(saved.board.nodes[1]!.data).toMatchObject({
    aspectRatio: "1:1",
    resolution: "1K",
    images: [{ type: "node", nodeId: "note0", studioEdgeId: "brief-concept", port: "text" }],
  });
  expect(saved.board.edges).toEqual([
    { id: "brief-concept", source: "note0", target: "concept", targetHandle: "text" },
  ]);
  await f.edit([{ op: "disconnect", id: "brief-concept" }]);
  expect((await f.snapshot()).board.nodes[1]!.data.images).toEqual([]);
  expect(f.calls).not.toContain("start");
});

test("dry runs do not write; stale revisions and invalid batches leave the original files intact", async () => {
  const f = await fixture();
  const initial = await f.snapshot();
  const before = await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8");
  const operation = { op: "update_node", id: "note0", patch: { title: "Draft" } };
  expect(await f.edit([operation], { dryRun: true })).toMatchObject({
    saved: false,
    revision: initial.revision,
  });
  expect(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8")).toBe(before);
  await expect(f.edit([operation, { op: "remove_node", id: "missing" }])).rejects.toThrow(
    "does not exist",
  );
  expect((await f.snapshot()).revision).toBe(initial.revision);
  await f.edit([operation]);
  const current = await f.snapshot();
  await expect(f.edit([operation], { revision: initial.revision, dryRun: true })).rejects.toThrow(
    "Current revision:",
  );
  expect((await f.snapshot()).revision).toBe(current.revision);
  for (const data of [
    { images: "bad" },
    { takes: [] },
    { references: [{ type: "node", nodeId: "missing" }] },
  ])
    await expect(f.edit([{ op: "update_node", id: "note0", patch: { data } }])).rejects.toThrow();
});

test("a full Start port cannot be overwritten and foreign threads cannot edit", async () => {
  const f = await fixture();
  await f.edit([
    { op: "add_node", node: { id: "frame", type: "image", data: {} } },
    { op: "add_node", node: { id: "frame2", type: "image", data: {} } },
    { op: "add_node", node: { id: "clip", type: "video", data: {} } },
    { op: "connect", id: "start", source: "frame", target: "clip", port: "start" },
  ]);
  const before = await f.snapshot();
  await expect(
    f.edit([{ op: "connect", id: "start2", source: "frame2", target: "clip", port: "start" }]),
  ).rejects.toThrow("free input port");
  expect((await f.snapshot()).revision).toBe(before.revision);
  await expect(
    f.harness.callAgentTool(
      "game_studio_canvas_edit",
      {
        gameId: "game",
        boardId: "main",
        revision: before.revision,
        operations: [{ op: "remove_node", id: "note0" }],
      },
      { threadId: "foreign" },
    ),
  ).rejects.toThrow("game's BB project");
  await expect(
    f.harness.callAgentTool(
      "game_studio_canvas_context",
      { gameId: "game" },
      { threadId: "foreign" },
    ),
  ).rejects.toThrow("game's BB project");
  await f.edit([{ op: "remove_node", id: "frame" }]);
  const final = await f.snapshot();
  expect(final.board.edges).toEqual([]);
  expect(final.board.nodes.find(({ id }) => id === "clip")!.data.references).toEqual([]);
});

test("library inputs accept images, replace without losing the node, and reject model assets", async () => {
  const f = await fixture();
  await mkdir(join(f.rootPath, "assets"));
  await f.seed("assets/a.png", "image-a");
  await f.seed("assets/b.png", "image-b");
  await f.seed("assets/mesh.glb", "model");
  await f.seed("canvas/assets.json", {
    version: 1,
    assets: {
      a: { name: "A", path: "assets/a.png" },
      b: { name: "B", path: "assets/b.png" },
      mesh: { name: "Mesh", path: "assets/mesh.glb" },
    },
  });
  const original = await f.snapshot();
  for (const dryRun of [false, true])
    await expect(
      f.edit(
        [
          {
            op: "add_node",
            node: {
              id: "bad",
              type: "image",
              data: { images: [{ type: "library", assetId: "mesh" }] },
            },
          },
        ],
        { dryRun },
      ),
    ).rejects.toThrow("existing image asset");
  expect((await f.snapshot()).revision).toBe(original.revision);
  await f.edit([
    {
      op: "add_node",
      node: {
        id: "clip",
        type: "video",
        data: { references: [{ type: "library", assetId: "a", port: "start" }] },
      },
    },
  ]);
  const saved = JSON.parse(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8"));
  saved.nodes.find((node: { id: string }) => node.id === "clip").data.takes = [
    { assetId: "a", jobId: "previous" },
  ];
  await f.seed("canvas/boards/main.json", saved);
  await f.edit([
    { op: "remove_input", id: "clip", input: { key: "references", index: 0 } },
    { op: "connect_asset", target: "clip", assetId: "b", port: "start" },
  ]);
  const clip = (await f.snapshot()).board.nodes.find(({ id }) => id === "clip")!;
  expect(clip.data.references).toEqual([{ type: "library", assetId: "b", port: "start" }]);
  expect(clip.data.takes).toEqual([{ assetId: "a", jobId: "previous" }]);
  await expect(
    f.edit([{ op: "connect_asset", target: "clip", assetId: "mesh", port: "end" }]),
  ).rejects.toThrow("existing image asset");
  await expect(
    f.edit([{ op: "update_node", id: "clip", patch: { data: { assetId: "missing" } } }]),
  ).rejects.toThrow("existing asset");
});

test("stale and overfilled inputs do not prevent unrelated edits and can be removed in place", async () => {
  const f = await fixture();
  const saved = JSON.parse(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8"));
  saved.nodes.push({
    id: "stale",
    type: "model-3d",
    data: {
      recipe: "tripo-rig",
      images: [
        { type: "library", assetId: "deleted", port: "front" },
        { type: "library", assetId: "also-deleted", port: "left" },
      ],
      promptSource: { type: "node", nodeId: "gone" },
    },
  });
  await f.seed("canvas/boards/main.json", saved);
  await f.edit([
    { op: "move_node", id: "note0", position: { x: 1000, y: 200 } },
    { op: "update_node", id: "note0", patch: { data: { text: "New brief" } } },
  ]);
  expect((await f.snapshot()).board.nodes[0]!.position).toEqual({ x: 1000, y: 200 });
  await f.edit([{ op: "remove_input", id: "stale", input: { key: "images", index: 0 } }]);
  expect(
    (await f.snapshot()).board.nodes.find(({ id }) => id === "stale")!.data.images,
  ).toHaveLength(1);
  await f.edit([{ op: "remove_input", id: "stale", input: { key: "promptSource" } }]);
  expect(
    (await f.snapshot()).board.nodes.find(({ id }) => id === "stale")!.data,
  ).not.toHaveProperty("promptSource");
});

test("new nodes reject malformed or wireless promptSource inputs before saving", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  for (const promptSource of [
    "bad",
    { type: "library", assetId: "missing" },
    { type: "node", nodeId: "note0" },
  ])
    for (const dryRun of [false, true])
      await expect(
        f.edit(
          [{ op: "add_node", node: { id: "invalid", type: "image", data: { promptSource } } }],
          { dryRun },
        ),
      ).rejects.toThrow("Use connect");
  expect((await f.snapshot()).revision).toBe(before.revision);
});
