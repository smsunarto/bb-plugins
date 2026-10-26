import type { Asset, Board, CanvasNode } from "./schema.ts";
import type { z } from "zod";
import type { inputSelection } from "./canvas-agent.ts";
import { nodeRefs, outputType, type InputRef } from "./inputs.ts";
import { nodeInputs } from "./recipes.ts";
import { filterNodeReferences } from "./node-references.ts";

/*
 * A node's saved inputs (`data.images`, `data.references`, and the legacy `data.promptSource`)
 * are the only record of its wires. The board's `edges` are derived from them, so a wire and the
 * input it feeds can never disagree. Persisted edges only lend their ids to inputs saved before
 * inputs carried one.
 */

type Graph = Pick<Board, "nodes" | "edges">;
export type GraphEdge = Board["edges"][number];
/** One wire and the saved input it stands for. */
export type WireEntry = {
  edge: GraphEdge;
  nodeId: string;
  input: z.output<typeof inputSelection>;
};

const kindOf = (nodes: CanvasNode[]) => (id: string) => nodes.find((node) => node.id === id)?.type;
function requiredNode(graph: Graph, id: string) {
  const node = graph.nodes.find((node) => node.id === id);
  if (!node) throw new Error(`Node ${id} does not exist.`);
  return node;
}

/** A short stable id for a legacy input: FNV-1a over its endpoints, within idSchema. */
function wireId(source: string, target: string) {
  let hash = 0x811c9dc5;
  for (const char of `${source}\0${target}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `w${hash.toString(16).padStart(8, "0")}`;
}

/** Where each saved input lives on its node, in `nodeRefs` order. */
function inputSelections(node: CanvasNode): { ref: InputRef; input: WireEntry["input"] }[] {
  const entries: { ref: InputRef; input: WireEntry["input"] }[] = [];
  const isRef = (value: unknown): value is InputRef =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isRef(node.data.promptSource))
    entries.push({ ref: node.data.promptSource, input: { key: "promptSource" } });
  for (const key of ["images", "references"] as const) {
    const refs = node.data[key];
    if (!Array.isArray(refs)) continue;
    refs.forEach((ref, index) => {
      if (isRef(ref)) entries.push({ ref, input: { key, index } });
    });
  }
  return entries;
}

/**
 * The board's wires, one per saved node input, landing on the port `nodeInputs` places the input
 * on. An input keeps the id it was connected with; an older input takes an unclaimed persisted
 * edge between the same nodes, else a stable id from its endpoints. Ids are unique by construction.
 */
export function wireEntries(nodes: CanvasNode[], hints: GraphEdge[] = []): WireEntry[] {
  const kinds = kindOf(nodes);
  const ids = new Set(nodes.map((node) => node.id));
  const taken = new Set<string>();
  const unclaimed = hints.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const entries: WireEntry[] = [];
  for (const node of nodes) {
    const selections = inputSelections(node);
    for (const { port, refs } of nodeInputs(node, kinds)) {
      for (const ref of refs) {
        if (ref.type !== "node" || typeof ref.nodeId !== "string") continue;
        const source = ref.nodeId;
        if (source === node.id || !ids.has(source)) continue;
        const selection = selections.find((entry) => entry.ref === ref);
        if (!selection) continue;
        const saved =
          typeof ref.studioEdgeId === "string" && !taken.has(ref.studioEdgeId)
            ? ref.studioEdgeId
            : undefined;
        // An input with its own id leaves the persisted edges to the older inputs beside it.
        let hint: string | undefined;
        if (saved) {
          const same = unclaimed.findIndex((edge) => edge.id === saved);
          if (same >= 0) unclaimed.splice(same, 1);
        } else {
          const hintIndex = unclaimed.findIndex(
            (edge) => edge.source === source && edge.target === node.id,
          );
          hint = hintIndex >= 0 ? unclaimed.splice(hintIndex, 1)[0]!.id : undefined;
        }
        const base = saved ?? hint ?? wireId(source, node.id);
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
        taken.add(id);
        entries.push({
          edge: { id, source, target: node.id, targetHandle: port.id },
          nodeId: node.id,
          input: selection.input,
        });
      }
    }
  }
  return entries;
}
/** The board's wires; see `wireEntries`. */
export function graphEdges(nodes: CanvasNode[], hints: GraphEdge[] = []): GraphEdge[] {
  return wireEntries(nodes, hints).map(({ edge }) => edge);
}
/** The graph with its wires derived again from its nodes' inputs. */
export function withEdges<T extends Graph>(graph: T): T {
  return { ...graph, edges: graphEdges(graph.nodes, graph.edges) };
}

/** Apply input changes over the latest local edit or generation result. */
export function copyInputFields(current: CanvasNode["data"], source: CanvasNode["data"]) {
  const data = { ...current };
  for (const key of ["images", "references", "promptSource"]) {
    const value = source[key];
    if (value === undefined) delete data[key];
    else data[key] = value;
  }
  return data;
}
function withData(graph: Graph, id: string, data: CanvasNode["data"]): Graph {
  return withEdges({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id ? Object.assign({}, node, { data: copyInputFields(node.data, data) }) : node,
    ),
  });
}
const inputKey = (node: CanvasNode) =>
  ["image", "model-3d"].includes(node.type) ? "images" : "references";

/** The same port check for UI hover feedback and saved connections. */
export function availableInputPort(
  graph: Graph,
  source: string,
  target: string,
  requested?: string,
) {
  const node = graph.nodes.find((node) => node.id === target);
  if (!node || source === target) return undefined;
  if (nodeRefs(node).some((ref) => ref.type === "node" && ref.nodeId === source)) return undefined;
  const kinds = kindOf(graph.nodes);
  return nodeInputs(node, kinds).find(
    ({ port, refs }) =>
      port.type === outputType(kinds(source)) &&
      (!requested || port.id === requested) &&
      refs.length < port.max,
  )?.port;
}

export function connectInput(
  graph: Graph,
  input: { id: string; source: string; target: string; port?: string },
): Graph {
  if (graphEdges(graph.nodes, graph.edges).some((edge) => edge.id === input.id))
    throw new Error(`Edge ${input.id} already exists.`);
  requiredNode(graph, input.source);
  const target = requiredNode(graph, input.target);
  const port = availableInputPort(graph, input.source, input.target, input.port);
  if (!port)
    throw new Error(
      "No compatible free input port. Remove the old input before connecting a replacement.",
    );
  const key = inputKey(target),
    refs = target.data[key];
  return withData(graph, target.id, {
    ...target.data,
    [key]: [
      ...(Array.isArray(refs) ? refs : []),
      { type: "node", nodeId: input.source, studioEdgeId: input.id, port: port.id },
    ],
  });
}

export function connectAssetInput(
  graph: Graph,
  assets: Asset[],
  input: { target: string; assetId: string; port?: string },
): Graph {
  const asset = assets.find((asset) => asset.id === input.assetId);
  if (asset?.type !== "image") throw new Error("Library inputs require an existing image asset.");
  const target = requiredNode(graph, input.target);
  const slot = nodeInputs(target, kindOf(graph.nodes)).find(
    ({ port, refs }) =>
      port.type === "image" && (!input.port || port.id === input.port) && refs.length < port.max,
  );
  if (!slot) throw new Error("No compatible free image input port.");
  if (slot.refs.some((ref) => ref.type === "library" && ref.assetId === asset.id))
    throw new Error("This image is already connected to that port.");
  const key = inputKey(target),
    refs = target.data[key];
  return withData(graph, target.id, {
    ...target.data,
    [key]: [
      ...(Array.isArray(refs) ? refs : []),
      { type: "library", assetId: asset.id, port: slot.port.id },
    ],
  });
}

/** Remove all uses of one node source, including wireless legacy promptSource inputs. */
export function disconnectSource(graph: Graph, target: string, source: string): Graph {
  const node = requiredNode(graph, target);
  return withData(
    graph,
    target,
    filterNodeReferences(node.data, (id) => id !== source),
  );
}

/** A removed wire stops feeding the model: the input it stood for is removed with it. */
export function disconnectInput(graph: Graph, id: string): Graph {
  const entry = wireEntries(graph.nodes, graph.edges).find(({ edge }) => edge.id === id);
  if (!entry) {
    const edge = graph.edges.find((edge) => edge.id === id);
    if (!edge) throw new Error(`Edge ${id} does not exist.`);
    // The wire's node is already gone; the derived edges no longer show it.
    return withEdges(graph);
  }
  return removeInput(graph, entry.nodeId, entry.input);
}

/** Indexes refer to the exact saved revision, so missing library and legacy inputs remain removable. */
export function removeInput(
  graph: Graph,
  id: string,
  input: z.output<typeof inputSelection>,
): Graph {
  const node = requiredNode(graph, id),
    data = { ...node.data };
  if (input.key === "promptSource") {
    if (data.promptSource === undefined) throw new Error("This node has no promptSource input.");
    delete data.promptSource;
  } else {
    const refs = data[input.key];
    if (!Array.isArray(refs) || input.index >= refs.length)
      throw new Error("The input index does not exist.");
    data[input.key] = refs.filter((_, index) => index !== input.index);
  }
  return withData(graph, id, data);
}
