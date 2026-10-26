import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { nodeDisk } from "../../host/canvas.ts";
import { canvasHostRouter } from "../../../test/canvas-host.ts";
import { loadWorkspace } from "./studio.ts";
import { CanvasEditStore, summarizeEdit } from "./canvas-edits.ts";
import { boardSchema, type Workspace } from "../../shared/schema.ts";

/*
 * What the server changes on a board for an agent is remembered with what it changed, and the
 * studio can put it back while the edit is still the latest content. These tests drive the
 * agent's tool and the studio's undo through the real plugin.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "studio-edits-"));
  const canvas = canvasHostRouter(
    () => nodeDisk,
    async (root) => ({ workspacePath: root, jobs: [], stale: false }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, projectId: "project", environmentId: "environment" }),
      },
      environments: {
        get: async () => ({ id: "environment", hostId: "host", path: rootPath }) as never,
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
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
  const seed = async (path: string, value: unknown) => {
    await mkdir(join(rootPath, path, ".."), { recursive: true });
    await writeFile(join(rootPath, path), JSON.stringify(value));
  };
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
  await seed("canvas/assets.json", {
    version: 1,
    assets: { front: { name: "Front", path: "assets/front.png" } },
  });
  await mkdir(join(rootPath, "assets"), { recursive: true });
  await writeFile(join(rootPath, "assets/front.png"), "png");
  await seed("canvas/boards/main.json", {
    version: 1,
    id: "main",
    viewport: { width: 1280, height: 720 },
    edges: [],
    nodes: [
      { id: "brief", type: "text", title: "Brief", data: { text: "A brass key" } },
      {
        id: "hero",
        type: "image",
        title: "Hero",
        data: { recipe: "nano-banana", prompt: "Hero", assetId: "front" },
      },
    ],
  });
  await seed("canvas/editor/main.json", {
    version: 1,
    view: "canvas",
    nodes: { brief: { x: 10, y: 20 }, hero: { x: 400, y: 20 } },
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const shown = async () => {
    const result = (await harness.callRpc("syncWorkspace", { gameId: "game" })) as {
      workspace: Workspace;
    };
    return result.workspace.boards[0]!;
  };
  const edit = async (operations: unknown[], threadId = "owner") => {
    const { revision } = await loadWorkspace(bb, "game").then((w) => w.boards[0]!);
    const result = await harness.callAgentTool(
      "game_studio_canvas_edit",
      { gameId: "game", boardId: "main", revision, operations },
      { threadId },
    );
    return JSON.parse(result as string) as { editId: string; revision: string };
  };
  const undo = (editId: string) =>
    harness.callRpc("undoCanvasEdit", { gameId: "game", boardId: "main", editId, threadId: null });
  return { bb, harness, rootPath, seed, shown, edit, undo };
}

test("summarizing an edit names what changed, not where things moved", () => {
  const before = boardSchema.parse({
    version: 1,
    id: "b",
    viewport: { width: 1, height: 1 },
    edges: [{ id: "a-b", source: "a", target: "b" }],
    editorLayout: { version: 1, view: "canvas", nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [
      { id: "a", type: "text", title: "A", position: { x: 0, y: 0 }, data: { text: "one" } },
      { id: "b", type: "image", position: { x: 0, y: 0 }, data: { prompt: "x" } },
      { id: "c", type: "text", title: "C", position: { x: 0, y: 0 }, data: {} },
    ],
  });
  const after = boardSchema.parse({
    ...before,
    edges: [{ id: "a-d", source: "a", target: "d" }],
    nodes: [
      { id: "a", type: "text", title: "A", position: { x: 9, y: 9 }, data: { text: "two" } },
      { id: "b", type: "image", title: "B", position: { x: 0, y: 0 }, data: { prompt: "x" } },
      { id: "d", type: "video", title: "D", position: { x: 0, y: 0 }, data: {} },
    ],
  });
  expect(summarizeEdit(before, after)).toEqual({
    added: [{ id: "d", title: "D", type: "video" }],
    removed: [{ id: "c", title: "C", type: "text" }],
    updated: [
      { id: "a", title: "A", type: "text", fields: ["text"] },
      { id: "b", title: "B", type: "image", fields: ["title"] },
    ],
    connected: [{ id: "a-d", source: "a", target: "d" }],
    disconnected: [{ id: "a-b", source: "a", target: "b" }],
  });
});

test("an agent's edit is shown with what it changed, and the studio can undo and redo it", async () => {
  const f = await fixture();
  const before = await f.shown();
  const result = await f.edit([
    { op: "add_node", node: { id: "concept", type: "image", title: "Concept", data: {} } },
    { op: "connect", id: "brief-concept", source: "brief", target: "concept", port: "text" },
    { op: "update_node", id: "brief", patch: { data: { text: "A rusty key" } } },
  ]);
  expect(result.editId).toMatch(/^[0-9a-f-]{36}$/);
  const edited = await f.shown();
  expect(edited.edits).toEqual([
    expect.objectContaining({
      id: result.editId,
      threadId: "owner",
      undoable: true,
      summary: {
        added: [{ id: "concept", title: "Concept", type: "image" }],
        removed: [],
        updated: [{ id: "brief", title: "Brief", type: "text", fields: ["text"] }],
        connected: [{ id: "brief-concept", source: "brief", target: "concept" }],
        disconnected: [],
      },
    }),
  ]);
  // The person moves the brief: layout alone does not move the board past the edit.
  const moved = {
    ...edited.board,
    nodes: edited.board.nodes.map((node) =>
      node.id === "brief" ? { ...node, position: { x: 99, y: 98 } } : node,
    ),
  };
  const { revision } = (await f.harness.callRpc("saveBoard", {
    gameId: "game",
    board: moved,
    revision: edited.revision,
  })) as { revision: string };
  expect((await f.shown()).edits[0]).toMatchObject({ id: result.editId, undoable: true });
  // Undo puts the content back and keeps the layout as it is now.
  await f.undo(result.editId);
  const undone = await f.shown();
  expect(undone.revision).not.toBe(revision);
  expect(undone.board.nodes.map(({ id }) => id)).toEqual(["brief", "hero"]);
  expect(undone.board.nodes[0]).toMatchObject({
    position: { x: 99, y: 98 },
    data: { text: "A brass key" },
  });
  expect(undone.board.edges).toEqual([]);
  expect(undone.edits.map(({ id, undoable }) => ({ id, undoable }))).toEqual([
    { id: undone.edits[0]!.id, undoable: true },
    { id: result.editId, undoable: false },
  ]);
  expect(undone.edits[0]).toMatchObject({
    threadId: null,
    undoOf: result.editId,
    summary: {
      added: [],
      removed: [{ id: "concept", title: "Concept", type: "image" }],
      updated: [{ id: "brief", fields: ["text"] }],
      disconnected: [{ id: "brief-concept", source: "brief", target: "concept" }],
    },
  });
  // Undoing the undo puts the agent's change back.
  await f.undo(undone.edits[0]!.id);
  const redone = await f.shown();
  expect(redone.board.nodes.map(({ id }) => id)).toEqual(["brief", "hero", "concept"]);
  expect(redone.edits).toHaveLength(3);
  // A studio save that changes content moves the board on; the edit stays as history.
  await f.harness.callRpc("saveBoard", {
    gameId: "game",
    board: {
      ...redone.board,
      nodes: redone.board.nodes.map((node) =>
        node.id === "hero" ? { ...node, title: "Hero shot" } : node,
      ),
    },
    revision: redone.revision,
  });
  expect((await f.shown()).edits[0]).toMatchObject({ id: redone.edits[0]!.id, undoable: false });
  await expect(f.undo(redone.edits[0]!.id)).rejects.toThrow("has changed since");
  expect(before.board.nodes).toHaveLength(2);
});

test("an edit cannot be undone when what it removed used an asset that is gone", async () => {
  const f = await fixture();
  const removal = await f.edit([{ op: "remove_node", id: "hero" }]);
  expect((await f.shown()).edits[0]).toMatchObject({ id: removal.editId, undoable: true });
  await f.seed("canvas/assets.json", { version: 1, assets: {} });
  expect((await f.shown()).edits[0]).toMatchObject({ id: removal.editId, undoable: false });
  await expect(f.undo(removal.editId)).rejects.toThrow("no longer exists (front)");
  const board = JSON.parse(await readFile(join(f.rootPath, "canvas/boards/main.json"), "utf8"));
  expect(board.nodes.map((node: { id: string }) => node.id)).toEqual(["brief"]);
});

test("a board keeps its newest twenty edits", async () => {
  const f = await fixture();
  const store = new CanvasEditStore(f.bb.storage.database());
  const board = (await loadWorkspace(f.bb, "game")).boards[0]!.board;
  for (let i = 0; i < 22; i++)
    store.record({
      gameId: "game",
      boardId: "main",
      threadId: "owner",
      before: board,
      after: { ...board, name: `v${i}` },
      beforeRevision: JSON.stringify({ content: `c${i}`, layout: null }),
      afterRevision: JSON.stringify({ content: `c${i + 1}`, layout: null }),
    });
  const kept = store.list("game");
  expect(kept).toHaveLength(20);
  expect(kept[0]!.afterContent).toBe("c22");
  expect(kept[19]!.afterContent).toBe("c3");
});
