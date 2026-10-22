import type { Asset, Board, CanvasNode } from "./schema.ts";
import type { z } from "zod";
import type { inputSelection } from "./canvas-agent.ts";
import { nodeRefs, outputType } from "./inputs.ts";
import { nodeInputs } from "./recipes.ts";
import { filterNodeReferences } from "./node-references.ts";

type Graph = Pick<Board, "nodes" | "edges">;
const kindOf = (graph: Graph) => (id: string) => graph.nodes.find((node) => node.id === id)?.type;
function requiredNode(graph: Graph, id: string) {
  const node = graph.nodes.find((node) => node.id === id);
  if (!node) throw new Error(`Node ${id} does not exist.`);
  return node;
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
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id ? Object.assign({}, node, { data: copyInputFields(node.data, data) }) : node,
    ),
  };
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
  if (
    !node ||
    source === target ||
    graph.edges.some((edge) => edge.source === source && edge.target === target)
  )
    return undefined;
  if (nodeRefs(node).some((ref) => ref.type === "node" && ref.nodeId === source)) return undefined;
  return nodeInputs(node, kindOf(graph)).find(
    ({ port, refs }) =>
      port.type === outputType(kindOf(graph)(source)) &&
      (!requested || port.id === requested) &&
      refs.length < port.max,
  )?.port;
}

export function connectInput(
  graph: Graph,
  input: { id: string; source: string; target: string; port?: string },
): Graph {
  if (graph.edges.some((edge) => edge.id === input.id))
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
  const result = withData(graph, target.id, {
    ...target.data,
    [key]: [
      ...(Array.isArray(refs) ? refs : []),
      { type: "node", nodeId: input.source, studioEdgeId: input.id, port: port.id },
    ],
  });
  return {
    ...result,
    edges: [...graph.edges, { id: input.id, source: input.source, target: input.target }],
  };
}

export function connectAssetInput(
  graph: Graph,
  assets: Asset[],
  input: { target: string; assetId: string; port?: string },
): Graph {
  const asset = assets.find((asset) => asset.id === input.assetId);
  if (asset?.type !== "image") throw new Error("Library inputs require an existing image asset.");
  const target = requiredNode(graph, input.target);
  const slot = nodeInputs(target, kindOf(graph)).find(
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
  return {
    ...withData(
      graph,
      target,
      filterNodeReferences(node.data, (id) => id !== source),
    ),
    edges: graph.edges.filter((edge) => edge.target !== target || edge.source !== source),
  };
}

/** A removed wire must stop feeding the model. Legacy duplicate wires keep their input. */
export function disconnectInput(graph: Graph, id: string): Graph {
  const edge = graph.edges.find((edge) => edge.id === id);
  if (!edge) throw new Error(`Edge ${id} does not exist.`);
  const edges = graph.edges.filter((edge) => edge.id !== id);
  const replacement = edges.find(
    (other) => other.source === edge.source && other.target === edge.target,
  );
  const node = graph.nodes.find((node) => node.id === edge.target);
  if (!node) return { ...graph, edges };
  if (!replacement) return disconnectSource(graph, edge.target, edge.source);
  const data = { ...node.data };
  for (const key of ["images", "references"]) {
    const refs = data[key];
    if (Array.isArray(refs))
      data[key] = refs.map((ref) =>
        typeof ref === "object" &&
        ref !== null &&
        !Array.isArray(ref) &&
        ref.type === "node" &&
        ref.nodeId === edge.source &&
        ref.studioEdgeId === id
          ? Object.assign({}, ref, { studioEdgeId: replacement.id })
          : ref,
      );
  }
  return { ...withData(graph, node.id, data), edges };
}

/** Indexes refer to the exact saved revision, so missing library and legacy inputs remain removable. */
export function removeInput(
  graph: Graph,
  id: string,
  input: z.output<typeof inputSelection>,
): Graph {
  const node = requiredNode(graph, id),
    data = { ...node.data };
  let removed: CanvasNode["data"][string];
  if (input.key === "promptSource") {
    if (data.promptSource === undefined) throw new Error("This node has no promptSource input.");
    removed = data.promptSource;
    delete data.promptSource;
  } else {
    const refs = data[input.key];
    if (!Array.isArray(refs) || input.index >= refs.length)
      throw new Error("The input index does not exist.");
    const ref = refs[input.index];
    if (ref === undefined) throw new Error("The input index does not exist.");
    removed = ref;
    data[input.key] = refs.filter((_, index) => index !== input.index);
  }
  const result = withData(graph, id, data);
  if (
    typeof removed === "object" &&
    removed !== null &&
    !Array.isArray(removed) &&
    removed.type === "node" &&
    typeof removed.nodeId === "string"
  ) {
    const source = removed.nodeId;
    if (!nodeRefs({ data }).some((ref) => ref.type === "node" && ref.nodeId === source))
      result.edges = result.edges.filter((edge) => edge.target !== id || edge.source !== source);
  }
  return result;
}
