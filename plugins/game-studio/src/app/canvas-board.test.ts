import { expect, it } from "bun:test";
import { z } from "zod";
import type { Board } from "../shared/schema.ts";
import { boardSnapshot, rebaseBoard } from "./canvas-board.ts";

const board: Board = {
  version: 1,
  id: "main",
  viewport: { width: 1280, height: 720 },
  edges: [],
  nodes: [
    { id: "note", type: "text", position: { x: 0, y: 0 }, data: { text: "Core loop" } },
    {
      id: "image",
      type: "image",
      position: { x: 300, y: 0 },
      data: {
        images: [
          { type: "node", nodeId: "note", studioEdgeId: "link" },
          { type: "library", assetId: "reference-art" },
        ],
      },
    },
  ],
  editorLayout: { version: 1, view: "canvas", nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
};

it("saves the wires its inputs derive as valid RPC JSON", () => {
  const saved = boardSnapshot(board, board.nodes, [], { x: -80, y: 120, zoom: 0.5 });
  // The RPC boundary rejects explicit undefined values even in optional fields.
  expect(z.record(z.string(), z.json()).parse(saved).edges).toStrictEqual([
    { id: "link", source: "note", target: "image", targetHandle: "text" },
  ]);
  expect(saved.editorLayout.viewport).toStrictEqual({ x: -80, y: 120, zoom: 0.5 });
  expect(saved.editorLayout.fitView).toBe(false);
});

it("removes deleted-node connections and references while preserving library assets and draft positions", () => {
  const saved = boardSnapshot(
    board,
    [{ ...board.nodes[1]!, position: { x: 450, y: 260 } }],
    [{ id: "link", source: "note", target: "image" }],
    { x: 20, y: 60, zoom: 1 },
  );
  expect(saved.nodes).toStrictEqual([
    {
      id: "image",
      type: "image",
      position: { x: 450, y: 260 },
      data: { images: [{ type: "library", assetId: "reference-art" }] },
    },
  ]);
  expect(saved.edges).toStrictEqual([]);
  expect(saved.editorLayout.nodes).toStrictEqual({ image: { x: 450, y: 260 } });
  expect(board.nodes[1]!.data.images).toHaveLength(2);
});

it("rebases a local draft onto a generation result without losing either side", () => {
  const base: Board = {
    ...board,
    nodes: [
      { id: "note", type: "text", position: { x: 0, y: 0 }, data: { text: "Core loop" } },
      { id: "image", type: "image", position: { x: 300, y: 0 }, data: { prompt: "A key" } },
      { id: "old", type: "text", position: { x: 0, y: 200 }, data: {} },
    ],
    editorLayout: {
      ...board.editorLayout,
      nodes: { note: { x: 0, y: 0 }, image: { x: 300, y: 0 }, old: { x: 0, y: 200 } },
    },
  };
  // The draft moved the note, edited its text, deleted "old" and added "new".
  const local: Board = {
    ...base,
    nodes: [
      { id: "note", type: "text", position: { x: 40, y: 0 }, data: { text: "Combat loop" } },
      base.nodes[1]!,
      { id: "new", type: "video", position: { x: 600, y: 0 }, data: { prompt: "" } },
    ],
    editorLayout: {
      ...base.editorLayout,
      viewport: { x: 10, y: 20, zoom: 0.8 },
      nodes: { note: { x: 40, y: 0 }, image: { x: 300, y: 0 }, new: { x: 600, y: 0 } },
    },
  };
  // Meanwhile a generation attached an output and rewrote the image brief on disk.
  const remote: Board = {
    ...base,
    nodes: [
      base.nodes[0]!,
      {
        id: "image",
        type: "image",
        position: { x: 300, y: 0 },
        data: { prompt: "A brass key", assetId: "key", generationJobId: "job" },
      },
      base.nodes[2]!,
    ],
  };
  expect(rebaseBoard(base, local, remote)).toStrictEqual({
    ...base,
    nodes: [
      { id: "note", type: "text", position: { x: 40, y: 0 }, data: { text: "Combat loop" } },
      {
        id: "image",
        type: "image",
        position: { x: 300, y: 0 },
        data: { prompt: "A brass key", assetId: "key", generationJobId: "job" },
      },
      { id: "new", type: "video", position: { x: 600, y: 0 }, data: { prompt: "" } },
    ],
    editorLayout: {
      ...base.editorLayout,
      viewport: { x: 10, y: 20, zoom: 0.8 },
      nodes: { note: { x: 40, y: 0 }, image: { x: 300, y: 0 }, new: { x: 600, y: 0 } },
    },
  });
});

it("keeps the draft's own edit to a field the disk also changed", () => {
  const base: Board = { ...board, nodes: [{ ...board.nodes[1]!, data: { prompt: "A key" } }] };
  const local: Board = { ...base, nodes: [{ ...base.nodes[0]!, data: { prompt: "My key" } }] };
  const remote: Board = {
    ...base,
    nodes: [{ ...base.nodes[0]!, data: { prompt: "Their key", assetId: "art" } }],
  };
  expect(rebaseBoard(base, local, remote).nodes[0]!.data).toStrictEqual({
    prompt: "My key",
    assetId: "art",
  });
});

it("removes a linked prompt source when its node is deleted", () => {
  const linked = structuredClone(board);
  linked.nodes[1]!.data.promptSource = { type: "node", nodeId: "note" };
  const saved = boardSnapshot(linked, [linked.nodes[1]!], [], linked.editorLayout.viewport);
  expect(saved.nodes[0]!.data).not.toHaveProperty("promptSource");
  expect(saved.nodes[0]!.data.images).toEqual([{ type: "library", assetId: "reference-art" }]);
});

it("also removes prompt sources to draft nodes deleted before the first save", () => {
  const draft = structuredClone(board.nodes[1]!);
  draft.data.promptSource = { type: "node", nodeId: "never-saved" };
  draft.data.images = [{ type: "node", nodeId: "never-saved" }];
  const saved = boardSnapshot(board, [draft], [], board.editorLayout.viewport);
  expect(saved.nodes[0]!.data).not.toHaveProperty("promptSource");
  expect(saved.nodes[0]!.data.images).toEqual([]);
});
