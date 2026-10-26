import { expect, test } from "bun:test";
import type { Board, CanvasNode } from "./schema.ts";
import { hasOutput, inputsReady, planRun } from "./canvas-plan.ts";

const node = (
  id: string,
  type: CanvasNode["type"],
  data: CanvasNode["data"],
  inputs: string[] = [],
): CanvasNode => ({
  id,
  type,
  title: id,
  position: { x: 0, y: 0 },
  data: {
    ...data,
    [type === "image" || type === "model-3d" ? "images" : "references"]: inputs.map((nodeId) => ({
      type: "node",
      nodeId,
    })),
  },
});
const board = (...nodes: CanvasNode[]): Pick<Board, "nodes"> => ({ nodes });

test("a run makes the inputs without an output, inputs first, and stops at a used pick", () => {
  // brief -> concept (no pick) -> turnaround (no pick) -> model; an unrelated old sheet has a pick.
  const graph = board(
    node("brief", "text", { text: "A courier" }),
    node("sheet", "image", { prompt: "Old sheet", assetId: "sheet-1" }, ["brief"]),
    node("concept", "image", { prompt: "Concept" }, ["brief", "sheet"]),
    node("turnaround", "image", { prompt: "Turnaround" }, ["concept"]),
    node("final", "image", { prompt: "Final" }, ["turnaround", "sheet"]),
  );
  const plan = planRun(graph, "final");
  expect(plan.missing).toEqual(["concept", "turnaround"]);
  expect(plan.queue).toEqual(["concept", "turnaround", "final"]);
  expect(plan.gate).toBeUndefined();
  expect(plan.issues).toEqual([]);
  expect(inputsReady(graph, graph.nodes[2]!)).toBe(true);
  expect(inputsReady(graph, graph.nodes[3]!)).toBe(false);
  // A pick that is used as it is never schedules what made it.
  expect(hasOutput(graph.nodes[1]!)).toBe(true);
  expect(planRun(graph, "sheet").queue).toEqual(["sheet"]);
});

test("an approved input stops the run before the step that consumes it", () => {
  const graph = board(
    node("brief", "text", { text: "A courier" }),
    node("front", "image", { prompt: "Front view" }, ["brief"]),
    node("mesh", "model-3d", { recipe: "model-3d", images: [] }),
    node("uv", "model-3d", { recipe: "tripo-smart-uv" }, ["mesh"]),
    node("applied", "model-3d", { recipe: "tripo-apply-uv" }, ["uv"]),
    node("textured", "model-3d", { recipe: "tripo-texture" }, ["applied"]),
  );
  graph.nodes[2]!.data.images = [{ type: "node", nodeId: "front", port: "front" }];
  const plan = planRun(graph, "textured");
  expect(plan.missing).toEqual(["front", "mesh", "uv", "applied"]);
  expect(plan.queue).toEqual(["front"]);
  expect(plan.gate).toEqual({ nodeId: "mesh", port: "front", sourceId: "front" });
  // With the front view approved, the chain runs to the UV candidate and waits again there.
  graph.nodes[1]!.data.assetId = "front-1";
  const next = planRun(graph, "textured");
  expect(next.queue).toEqual(["mesh", "uv"]);
  expect(next.gate).toEqual({ nodeId: "applied", port: "model", sourceId: "uv" });
  // A chosen candidate lets Apply UV run as part of the chain.
  graph.nodes[2]!.data.assetId = "mesh-1";
  graph.nodes[3]!.data.assetId = "uv-1";
  expect(planRun(graph, "textured")).toMatchObject({ queue: ["applied", "textured"] });
});

test("what cannot run is named before anything starts", () => {
  const graph = board(
    node("voice", "asset", {}),
    node("empty", "text", { text: "", instruction: "" }),
    node("art", "image", { prompt: "" }, ["voice", "empty"]),
    node("mesh", "model-3d", { recipe: "model-3d", images: [] }),
    node("clip", "video", { prompt: "" }, ["art"]),
  );
  expect(planRun(graph, "clip").issues.map(({ message }) => message)).toEqual([
    "Audio node “voice” has no output. Import one, or ask the agent to generate it.",
    "Note “empty” is empty. Write it, or write an instruction for the agent.",
    "Write a brief for “clip”.",
  ]);
  expect(planRun(graph, "mesh").issues).toEqual([
    { nodeId: "mesh", message: "“mesh” needs a Front input." },
  ]);
  // Connected text stands in for a brief; an agent instruction makes a note runnable.
  graph.nodes[1]!.data.instruction = "Write the courier's backstory";
  graph.nodes[2]!.data.images = [{ type: "node", nodeId: "empty" }];
  expect(planRun(graph, "art").issues).toEqual([]);
  expect(planRun(graph, "art").queue).toEqual(["empty", "art"]);
  // A node without a brief or a connected note cannot run.
  graph.nodes[2]!.data.images = [];
  expect(planRun(graph, "art").issues).toEqual([
    { nodeId: "art", message: "Write a brief for “art”." },
  ]);
});

test("a cycle through missing inputs is reported instead of looping", () => {
  const graph = board(
    node("a", "image", { prompt: "A" }, ["b"]),
    node("b", "image", { prompt: "B" }, ["a"]),
  );
  const plan = planRun(graph, "a");
  expect(plan.issues[0]!.message).toContain("feeds itself");
  // A loop back into a node that already has an output refines it instead.
  graph.nodes[0]!.data.assetId = "a-1";
  expect(planRun(graph, "a")).toMatchObject({ queue: ["b", "a"], issues: [] });
  expect(() => planRun(graph, "gone")).toThrow("no longer exists");
});
