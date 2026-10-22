import { expect, test } from "bun:test";
import type { Board } from "./schema.ts";
import {
  copyInputFields,
  availableInputPort,
  connectInput,
  disconnectInput,
  disconnectSource,
  removeInput,
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

test("UI and agent connections use the same port and persist both wire and input", () => {
  const original = graph();
  expect(availableInputPort(original, "brief", "image")?.id).toBe("text");
  const saved = connectInput(original, { id: "wire", source: "brief", target: "image" });
  expect(saved.nodes[1]!.data.images).toEqual([
    { type: "node", nodeId: "brief", studioEdgeId: "wire", port: "text" },
  ]);
  expect(saved.edges).toEqual([{ id: "wire", source: "brief", target: "image" }]);
  expect(availableInputPort(saved, "brief", "image")).toBeUndefined();
  expect(original.nodes[1]!.data.images).toEqual([]);
});

test("deleting a wire removes wireless legacy refs and promptSource consistently", () => {
  const saved = graph();
  saved.nodes[1]!.data = {
    images: [{ type: "node", nodeId: "brief" }],
    promptSource: { type: "node", nodeId: "brief" },
  };
  saved.edges.push({ id: "wire", source: "brief", target: "image" });
  const removed = disconnectInput(saved, "wire");
  expect(removed.nodes[1]!.data).toEqual({ images: [] });
  expect(removed.edges).toEqual([]);
  expect(disconnectSource(saved, "image", "brief")).toEqual(removed);
  expect(saved.nodes[1]!.data).toHaveProperty("promptSource");
});

test("legacy duplicate wires retain an input until the final wire is removed", () => {
  let saved = connectInput(graph(), { id: "first", source: "brief", target: "image" });
  saved.edges.push({ id: "second", source: "brief", target: "image" });
  saved = disconnectInput(saved, "first");
  expect(saved.nodes[1]!.data.images).toEqual([
    { type: "node", nodeId: "brief", studioEdgeId: "second", port: "text" },
  ]);
  expect(disconnectInput(saved, "second").nodes[1]!.data.images).toEqual([]);
});

test("removing an indexed input drops its wire only when no corresponding input remains", () => {
  const saved = connectInput(graph(), { id: "wire", source: "brief", target: "image" });
  saved.nodes[1]!.data.promptSource = { type: "node", nodeId: "brief" };
  const first = removeInput(saved, "image", { key: "images", index: 0 });
  expect(first.edges).toHaveLength(1);
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
});
