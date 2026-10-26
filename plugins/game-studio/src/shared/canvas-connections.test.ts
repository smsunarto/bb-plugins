import { expect, test } from "bun:test";
import type { Board } from "./schema.ts";
import {
  copyInputFields,
  availableInputPort,
  connectInput,
  disconnectInput,
  disconnectSource,
  graphEdges,
  removeInput,
  wireEntries,
} from "./canvas-connections.ts";

function graph(): Pick<Board, "nodes" | "edges"> {
  return {
    nodes: [
      { id: "brief", type: "text", position: { x: 0, y: 0 }, data: { text: "Direction" } },
      { id: "image", type: "image", position: { x: 300, y: 0 }, data: { images: [] } },
    ],
    edges: [],
  };
}

test("UI and agent connections save one input, and the wire derives from it on its port", () => {
  const original = graph();
  expect(availableInputPort(original, "brief", "image")?.id).toBe("text");
  const saved = connectInput(original, { id: "wire", source: "brief", target: "image" });
  expect(saved.nodes[1]!.data.images).toEqual([
    { type: "node", nodeId: "brief", studioEdgeId: "wire", port: "text" },
  ]);
  expect(saved.edges).toEqual([
    { id: "wire", source: "brief", target: "image", targetHandle: "text" },
  ]);
  expect(availableInputPort(saved, "brief", "image")).toBeUndefined();
  expect(() => connectInput(saved, { id: "wire", source: "brief", target: "image" })).toThrow(
    "already exists",
  );
  expect(original.nodes[1]!.data.images).toEqual([]);
});

test("legacy inputs adopt persisted edge ids, else stable ones, and never collide", () => {
  const saved = graph();
  // A board saved before inputs carried wire ids: two inputs from one source and one edge.
  saved.nodes[1]!.data = {
    images: [{ type: "node", nodeId: "brief" }],
    promptSource: { type: "node", nodeId: "brief" },
  };
  saved.edges.push({ id: "wire", source: "brief", target: "image" });
  const entries = wireEntries(saved.nodes, saved.edges);
  expect(entries.map(({ edge, input }) => [edge.id, edge.targetHandle, input])).toEqual([
    ["wire", "text", { key: "promptSource" }],
    [expect.stringMatching(/^w[0-9a-f]{8}$/), "text", { key: "images", index: 0 }],
  ]);
  // Without a persisted edge, the same inputs get the same ids every time.
  const bare = graphEdges(saved.nodes).map(({ id }) => id);
  expect(bare).toEqual(graphEdges(saved.nodes).map(({ id }) => id));
  expect(bare[1]).toBe(`${bare[0]}-2`);
  // An id saved on two inputs is kept once; the other input falls back to a stable id.
  saved.nodes[1]!.data = {
    images: [
      { type: "node", nodeId: "brief", studioEdgeId: "dup" },
      { type: "node", nodeId: "brief", studioEdgeId: "dup" },
    ],
  };
  expect(graphEdges(saved.nodes).map(({ id }) => id)).toEqual([
    "dup",
    expect.stringMatching(/^w[0-9a-f]{8}$/),
  ]);
});

test("wires land on the port execution assigns, including a portless input behind a taken slot", () => {
  const nodes: Board["nodes"] = [
    { id: "a", type: "image", position: { x: 0, y: 0 }, data: {} },
    { id: "b", type: "image", position: { x: 0, y: 0 }, data: {} },
    {
      id: "clip",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        references: [
          { type: "node", nodeId: "a", studioEdgeId: "first" },
          { type: "node", nodeId: "b", port: "start", studioEdgeId: "second" },
        ],
      },
    },
  ];
  expect(graphEdges(nodes)).toEqual([
    { id: "second", source: "b", target: "clip", targetHandle: "start" },
    { id: "first", source: "a", target: "clip", targetHandle: "end" },
  ]);
});

test("deleting a wire removes exactly the input it stood for; a source removal clears them all", () => {
  const saved = graph();
  saved.nodes[1]!.data = {
    images: [{ type: "node", nodeId: "brief" }],
    promptSource: { type: "node", nodeId: "brief" },
  };
  saved.edges.push({ id: "wire", source: "brief", target: "image" });
  const removed = disconnectInput(saved, "wire");
  expect(removed.nodes[1]!.data).toEqual({ images: [{ type: "node", nodeId: "brief" }] });
  expect(removed.edges).toHaveLength(1);
  const cleared = disconnectSource(saved, "image", "brief");
  expect(cleared.nodes[1]!.data).toEqual({ images: [] });
  expect(cleared.edges).toEqual([]);
  expect(saved.nodes[1]!.data).toHaveProperty("promptSource");
});

test("removing an indexed input drops its wire with it", () => {
  const saved = connectInput(graph(), { id: "wire", source: "brief", target: "image" });
  saved.nodes[1]!.data.promptSource = { type: "node", nodeId: "brief" };
  expect(saved.edges).toHaveLength(1);
  expect(graphEdges(saved.nodes, saved.edges)).toHaveLength(2);
  const first = removeInput(saved, "image", { key: "images", index: 0 });
  expect(first.edges).toHaveLength(1);
  expect(first.edges[0]!.targetHandle).toBe("text");
  const last = removeInput(first, "image", { key: "promptSource" });
  expect(last.edges).toEqual([]);
});

test("input changes preserve a newer local brief and collected output", () => {
  const latest = {
    prompt: "Unsaved new brief",
    assetId: "new-output",
    takes: [{ assetId: "new-output", jobId: "new-run" }],
    references: [{ type: "node", nodeId: "old" }],
  };
  const patch = {
    prompt: "Old brief",
    assetId: "old-output",
    references: [{ type: "node", nodeId: "new" }],
  };
  expect(copyInputFields(latest, patch)).toEqual({
    ...latest,
    references: [{ type: "node", nodeId: "new" }],
  });
});

test("wire deletion tolerates a target already removed by the UI", () => {
  const saved = connectInput(graph(), { id: "wire", source: "brief", target: "image" });
  saved.nodes = saved.nodes.filter((node) => node.id !== "image");
  expect(disconnectInput(saved, "wire").edges).toEqual([]);
  expect(() => disconnectInput(saved, "unknown")).toThrow("does not exist");
});

test("an input with its own wire id leaves a persisted edge to the legacy input beside it", () => {
  const saved = graph();
  saved.nodes[1]!.data = {
    promptSource: { type: "node", nodeId: "brief", studioEdgeId: "mine" },
    images: [{ type: "node", nodeId: "brief" }],
  };
  saved.edges.push({ id: "old", source: "brief", target: "image" });
  expect(wireEntries(saved.nodes, saved.edges).map(({ edge, input }) => [edge.id, input])).toEqual([
    ["mine", { key: "promptSource" }],
    ["old", { key: "images", index: 0 }],
  ]);
});
