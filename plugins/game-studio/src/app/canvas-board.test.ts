import { expect, it } from "bun:test";
import { z } from "zod";
import type { Board } from "../shared/schema.ts";
import { boardSnapshot } from "./canvas-board.ts";

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

it("saves a new unnamed-handle connection as valid RPC JSON", () => {
  const saved = boardSnapshot(
    board,
    board.nodes,
    [{ id: "link", source: "note", target: "image", sourceHandle: null, targetHandle: null }],
    { x: -80, y: 120, zoom: 0.5 },
  );
  // The RPC boundary rejects explicit undefined values even in optional fields.
  expect(z.record(z.string(), z.json()).parse(saved).edges).toStrictEqual([
    { id: "link", source: "note", target: "image" },
  ]);
  expect(saved.editorLayout.viewport).toStrictEqual({ x: -80, y: 120, zoom: 0.5 });
  expect(saved.editorLayout.fitView).toBe(false);
});

it("keeps named source handles in the saved connection", () => {
  const saved = boardSnapshot(
    board,
    board.nodes,
    [{ id: "link", source: "note", target: "image", sourceHandle: "output" }],
    { x: 0, y: 0, zoom: 1 },
  );
  expect(saved.edges).toStrictEqual([
    { id: "link", source: "note", target: "image", sourceHandle: "output" },
  ]);
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
