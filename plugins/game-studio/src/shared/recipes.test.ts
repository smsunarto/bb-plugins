import { expect, test } from "bun:test";
import { nodeInputPorts, nodeInputs, nodeTakesBrief } from "./recipes.ts";
import type { CanvasNode } from "./schema.ts";

test("each node offers the inputs its model reads", () => {
  const ports = (type: CanvasNode["type"], recipe?: string) =>
    nodeInputPorts({ type, data: recipe ? { recipe } : {} }).map(
      ({ label, max, required }) => `${label}${required ? "*" : ""} ${max}`,
    );
  expect(ports("text")).toEqual(["Text Infinity", "Image 14"]);
  expect(ports("image", "concept-art")).toEqual(["Text Infinity", "Image 14"]);
  expect(ports("video", "fal-video")).toEqual(["Text Infinity", "Start 1", "End 1"]);
  expect(ports("model-3d")).toEqual(["Front* 1", "Left 1", "Back 1", "Right 1"]);
  expect(ports("model-3d", "tripo-smart-uv")).toEqual(["Model* 1"]);
  expect(ports("model-3d", "tripo-apply-uv")).toEqual(["UV candidate* 1"]);
  expect(ports("asset", "music")).toEqual(["Text Infinity"]);
  expect(ports("document")).toEqual([]);
});

test("a canvas model without a text input runs without a brief", () => {
  const briefed = (type: CanvasNode["type"], recipe?: string) =>
    nodeTakesBrief({ type, data: recipe ? { recipe } : {} });
  expect(briefed("agent")).toBe(true);
  expect(briefed("image", "nano-banana")).toBe(true);
  expect(briefed("video", "omni-video")).toBe(true);
  // Tripo P2 builds from its views alone.
  expect(briefed("model-3d")).toBe(false);
  expect(briefed("model-3d", "tripo-texture")).toBe(true);
  expect(["tripo-pbr", "tripo-rig", "tripo-animate"].map((id) => briefed("model-3d", id))).toEqual([
    false,
    false,
    false,
  ]);
});

test("saved ports win, older inputs fill open ports in order, and extras stay visible", () => {
  const kinds: Record<string, CanvasNode["type"]> = {
    a: "image",
    b: "image",
    c: "image",
    t: "text",
  };
  const placed = nodeInputs(
    {
      type: "video",
      data: {
        references: [
          { type: "node", nodeId: "a" },
          { type: "node", nodeId: "b", port: "start" },
          { type: "node", nodeId: "c" },
          { type: "node", nodeId: "t" },
          { type: "node", nodeId: "gone" },
        ],
      },
    },
    (id) => kinds[id],
  ).map(({ port, refs }) => [port.id, refs.map((ref) => ref.nodeId)]);
  expect(placed).toEqual([
    ["text", ["t"]],
    ["start", ["b"]],
    ["end", ["a", "c"]],
  ]);
  expect(
    nodeInputs(
      { type: "asset", data: { references: [{ type: "library", assetId: "x" }] } },
      () => undefined,
    ).map(({ port, refs }) => [port.id, port.max, refs.length]),
  ).toEqual([
    ["text", Infinity, 0],
    ["image", 0, 1],
  ]);
});
