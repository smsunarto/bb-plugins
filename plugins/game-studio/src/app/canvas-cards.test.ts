import { describe, expect, it } from "bun:test";
import type { Edge } from "@xyflow/react";
import { graphEdges } from "../shared/canvas-connections.ts";
import type { GenerationJob } from "../shared/generation.ts";
import type { Asset, CanvasNode } from "../shared/schema.ts";
import {
  baseCards,
  createFlowCache,
  prepareFlow,
  type Card,
  type FlowCache,
  type FlowInput,
} from "./canvas-cards.ts";

/*
 * React Flow keeps its internal node for a user node object it has seen, and a card's view
 * renders again only when its card object changes. These tests pin that identity contract:
 * an interaction that touches one node must hand React Flow the same objects for the rest.
 */

const note: CanvasNode = {
  id: "note",
  type: "text",
  position: { x: 0, y: 0 },
  data: { text: "Loop" },
};
const art: CanvasNode = {
  id: "art",
  type: "image",
  position: { x: 300, y: 0 },
  data: {
    prompt: "Relic",
    assetId: "relic",
    images: [{ type: "node", nodeId: "note", studioEdgeId: "link" }],
  },
};
const model: CanvasNode = {
  id: "model",
  type: "model-3d",
  position: { x: 600, y: 0 },
  data: { prompt: "", images: [{ type: "node", nodeId: "art", studioEdgeId: "feed" }] },
};
const board = {
  id: "main",
  nodes: [note, art, model],
  editorLayout: { nodes: { art: { x: 320, y: 10 } } },
};
// Wires derive from the nodes' inputs and carry the port they land on.
const edges: Edge[] = graphEdges(board.nodes);
const relic = {
  id: "relic",
  name: "relic.png",
  path: "canvas/staging/relic.png",
  type: "image",
} as Asset;
const job = (id: string, nodeId: string, kind: "image" | "model" = "image"): GenerationJob =>
  ({
    id,
    status: "running",
    target: { boardId: "main", nodeId },
    request: { kind },
    origin: { kind: "canvas" },
  }) as unknown as GenerationJob;

function input(overrides: Partial<FlowInput> = {}): FlowInput {
  return {
    nodes: baseCards(board),
    edges,
    boardId: "main",
    jobs: [],
    assets: [relic],
    documents: [],
    preview: undefined,
    starting: null,
    startingBrief: null,
    freshness: {},
    pending: {},
    ...overrides,
  };
}
/** The base nodes the cache last saw, as React Flow's state would hand them back unchanged. */
const held = (cache: FlowCache): Card[] => [...cache.cards.values()].map((entry) => entry.node);

describe("baseCards", () => {
  it("places each node at its saved editor position, else its own", () => {
    expect(baseCards(board).map((card) => [card.id, card.position])).toEqual([
      ["note", { x: 0, y: 0 }],
      ["art", { x: 320, y: 10 }],
      ["model", { x: 600, y: 0 }],
    ]);
  });
});

describe("prepareFlow", () => {
  it("gives a card its output, its inputs on ports, and its jobs, and lands edges on those ports", () => {
    const cache = createFlowCache();
    const running = job("j1", "art");
    const flow = prepareFlow(cache, input({ jobs: [running] }));
    const card = flow.nodes[1]!;
    expect(card.data.asset).toBe(relic);
    expect(card.data.jobs).toEqual([running]);
    expect(card.data.job).toBe(running);
    expect(card.data.busy).toBe(false);
    const holding = card.data.inputs!.find(({ refs }) => refs.length === 1)!;
    expect(holding.refs[0]!.studioEdgeId).toBe("link");
    expect(flow.edges[0]!.targetHandle).toBe(holding.port.id);
    expect(flow.edges[1]!.targetHandle).toBe(
      flow.nodes[2]!.data.inputs!.find(({ refs }) => refs.length === 1)!.port.id,
    );
  });

  it("hands back the same cards and edges when nothing changed", () => {
    const cache = createFlowCache();
    const jobs = [job("j1", "art")];
    const first = prepareFlow(cache, input({ jobs }));
    // Fresh wrapper arrays around the same items, as a workspace read hands back.
    const same = prepareFlow(
      cache,
      input({ nodes: held(cache), jobs: [...jobs], edges: [...edges], assets: [relic] }),
    );
    first.nodes.forEach((card, i) => expect(same.nodes[i]).toBe(card));
    first.edges.forEach((edge, i) => expect(same.edges[i]).toBe(edge));
  });

  it("changes only the card whose node changed", () => {
    const cache = createFlowCache();
    const first = prepareFlow(cache, input());
    const nodes = held(cache);
    const edited = {
      ...nodes[1]!,
      data: { source: { ...art, data: { ...art.data, prompt: "Older relic" } } },
    };
    const next = prepareFlow(cache, input({ nodes: [nodes[0]!, edited, nodes[2]!] }));
    expect(next.nodes[0]).toBe(first.nodes[0]!);
    expect(next.nodes[1]).not.toBe(first.nodes[1]!);
    expect(next.nodes[1]!.data.source.data.prompt).toBe("Older relic");
    expect(next.nodes[2]).toBe(first.nodes[2]!);
    next.edges.forEach((edge, i) => expect(edge).toBe(first.edges[i]!));
  });

  it("changes only the card whose jobs changed when a job list arrives", () => {
    const cache = createFlowCache();
    const j1 = job("j1", "art");
    const first = prepareFlow(cache, input({ jobs: [j1] }));
    // A workspace read keeps unchanged job objects, as TanStack Query's structural sharing does.
    const next = prepareFlow(
      cache,
      input({ nodes: held(cache), jobs: [j1, job("j2", "model", "model")] }),
    );
    expect(next.nodes[0]).toBe(first.nodes[0]!);
    expect(next.nodes[1]).toBe(first.nodes[1]!);
    expect(next.nodes[2]).not.toBe(first.nodes[2]!);
    expect(next.nodes[2]!.data.busy).toBe(true);
  });

  it("marks only the node being started as busy, or briefing", () => {
    const cache = createFlowCache();
    const first = prepareFlow(cache, input());
    const starting = prepareFlow(cache, input({ nodes: held(cache), starting: "model" }));
    expect(starting.nodes[0]).toBe(first.nodes[0]!);
    expect(starting.nodes[1]).toBe(first.nodes[1]!);
    expect(starting.nodes[2]!.data.busy).toBe(true);
    const briefing = prepareFlow(cache, input({ nodes: held(cache), startingBrief: "art" }));
    expect(briefing.nodes[0]).toBe(first.nodes[0]!);
    expect(briefing.nodes[1]!.data.briefing).toBe(true);
    expect(briefing.nodes[2]!.data.busy).toBe(false);
  });

  it("keeps cards whose asset object did not change when the asset list is new", () => {
    const cache = createFlowCache();
    const first = prepareFlow(cache, input());
    const next = prepareFlow(
      cache,
      input({ nodes: held(cache), assets: [relic, { ...relic, id: "other" }] }),
    );
    next.nodes.forEach((card, i) => expect(card).toBe(first.nodes[i]!));
  });

  it("recolors an edge, and keeps the others, when its source changes kind", () => {
    const cache = createFlowCache();
    const first = prepareFlow(cache, input());
    const nodes = held(cache);
    const retyped = { ...nodes[0]!, data: { source: { ...note, type: "image" as const } } };
    const next = prepareFlow(cache, input({ nodes: [retyped, nodes[1]!, nodes[2]!] }));
    expect(next.edges[0]).not.toBe(first.edges[0]!);
    expect(next.edges[0]!.style?.stroke).not.toBe(first.edges[0]!.style?.stroke);
    expect(next.edges[1]).toBe(first.edges[1]!);
  });

  it("forgets removed nodes and edges", () => {
    const cache = createFlowCache();
    prepareFlow(cache, input());
    prepareFlow(cache, input({ nodes: held(cache).slice(0, 2), edges: edges.slice(0, 1) }));
    expect([...cache.cards.keys()]).toEqual(["note", "art"]);
    expect([...cache.ports.keys()]).toEqual(["note", "art"]);
    expect([...cache.edges.keys()]).toEqual(["link"]);
  });
});

describe("held runs and freshness", () => {
  it("marks a held node busy, shows its freshness, and leaves the other cards alone", () => {
    const cache = createFlowCache();
    const first = prepareFlow(cache, input());
    const next = prepareFlow(
      cache,
      input({
        nodes: held(cache),
        pending: { art: { requestId: "r1", requestedAt: 1 } },
        freshness: { art: "stale" },
      }),
    );
    expect(next.nodes[1]!.data).toMatchObject({
      busy: true,
      pending: { requestId: "r1" },
      freshness: "stale",
    });
    expect(next.nodes[0]).toBe(first.nodes[0]);
    expect(next.nodes[2]).toBe(first.nodes[2]);
  });
});
