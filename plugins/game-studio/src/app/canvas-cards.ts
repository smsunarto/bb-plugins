// What React Flow renders for a board: the cards and edges, with the data their views show.
// Adapted from OhMyGame's canvas model; modified for BB. Apache-2.0.
import type { Edge, Node } from "@xyflow/react";
import type { GenerationJob } from "../shared/generation.ts";
import type { InputRef, PortInputs } from "../shared/inputs.ts";
import type { Preview } from "../shared/media-paths.ts";
import { nodeInputs } from "../shared/recipes.ts";
import type {
  Asset,
  CanvasNode,
  Freshness,
  NodeKind,
  PendingRun,
  StudioDocument,
} from "../shared/schema.ts";
import { isJudge } from "./judge.tsx";

export type CardData = {
  source: CanvasNode;
  /** The output the node links, and the document it shows. */
  asset?: Asset;
  document?: StudioDocument;
  preview?: Preview;
  /** Jobs targeting this node, newest first; `job` is the newest. */
  jobs?: GenerationJob[];
  job?: GenerationJob;
  busy?: boolean;
  /** A BB model is writing this media node's brief. */
  briefing?: boolean;
  /** The node's inputs placed on its model's ports. */
  inputs?: PortInputs<InputRef>[];
  /** Reviews of this node's outputs, newest first; kept apart from its generation jobs. */
  reviewJobs?: GenerationJob[];
  /** Whether the node's pick still reflects its brief and inputs. */
  freshness?: Freshness;
  /** A run the server holds until this node's inputs land. */
  pending?: PendingRun;
};
export type Card = Node<CardData, "studio">;

// Each kind owns its port and edge color. Monokai's ANSI hues keep the canvas themed.
export const kinds: { kind: NodeKind; label: string; icon: string; key?: string; color: string }[] =
  [
    { kind: "text", label: "Text", icon: "Type", key: "t", color: "var(--ansi-6, #51dae9)" },
    { kind: "image", label: "Image", icon: "Image", key: "i", color: "var(--ansi-3, #f1b467)" },
    { kind: "video", label: "Video", icon: "Video", key: "v", color: "var(--ansi-5, #a895fe)" },
    { kind: "asset", label: "Audio", icon: "Music", key: "a", color: "var(--ansi-10, #9ddd54)" },
    { kind: "model-3d", label: "3D", icon: "Box", color: "var(--ansi-9, #fe5d86)" },
    { kind: "agent", label: "Agent", icon: "Bot", key: "g", color: "var(--ansi-13, #c4a7ff)" },
    { kind: "document", label: "Document", icon: "FileText", color: "var(--ansi-12, #7cacfe)" },
    { kind: "table", label: "Table", icon: "Table", color: "var(--ansi-11, #f7d05c)" },
  ];
export const kindInfo = (kind: NodeKind | undefined) =>
  kinds.find((item) => item.kind === kind) ?? {
    kind,
    label: kind ?? "Node",
    icon: "Box",
    key: undefined,
    color: "var(--muted-foreground)",
  };

export const running = (job: GenerationJob) => job.status === "queued" || job.status === "running";
export const isBrief = (job: GenerationJob | undefined) =>
  job?.request.kind === "text" && !!job.request.briefFor;
export const isReview = (job: GenerationJob) =>
  job.request.kind === "text" && !!job.request.reviewOf;

/** The jobs targeting one node, newest first, by role. Reviews and judgements never make it busy. */
export type NodeJobs = {
  jobs: GenerationJob[];
  reviewJobs: GenerationJob[];
  judgeJobs: GenerationJob[];
};
const none: GenerationJob[] = [];
export const noJobs: NodeJobs = { jobs: none, reviewJobs: none, judgeJobs: none };

/** Image runs become takes, so a node stays usable while they generate. A held run is busy. */
export const nodeBusy = (
  id: string,
  group: NodeJobs,
  starting: string | null,
  startingBrief: string | null,
  pending?: PendingRun,
) =>
  !!pending ||
  starting === id ||
  startingBrief === id ||
  group.jobs.some((job) => running(job) && job.request.kind !== "image");
export const nodeBriefing = (id: string, group: NodeJobs, startingBrief: string | null) =>
  startingBrief === id || group.jobs.some((job) => running(job) && isBrief(job));

/** The cards a board shows, before their views' data is placed on them. */
export function baseCards(board: {
  nodes: CanvasNode[];
  editorLayout: { nodes: Record<string, { x: number; y: number }> };
}): Card[] {
  return board.nodes.map((node) => ({
    id: node.id,
    type: "studio",
    position: board.editorLayout.nodes[node.id] ?? node.position,
    data: { source: node },
  }));
}

type PortEntry = {
  source: CanvasNode;
  kinds: Map<string, NodeKind>;
  ports: PortInputs<InputRef>[];
};
type CardEntry = { node: Card; card: Card };
type EdgeEntry = { edge: Edge; handle: string | null; stroke: string; shown: Edge };
/**
 * What the last prepared flow was made from, so unchanged cards and edges keep their objects.
 * React Flow keeps its internal node for a user node it has seen, and a card's view only
 * renders again when its card object changes, so identity is what keeps the canvas idle.
 */
export type FlowCache = {
  jobs: { source: GenerationJob[] | null; boardId: string | null; groups: Map<string, NodeJobs> };
  kinds: Map<string, NodeKind>;
  ports: Map<string, PortEntry>;
  cards: Map<string, CardEntry>;
  edges: Map<string, EdgeEntry>;
};
export const createFlowCache = (): FlowCache => ({
  jobs: { source: null, boardId: null, groups: new Map() },
  kinds: new Map(),
  ports: new Map(),
  cards: new Map(),
  edges: new Map(),
});

export type FlowInput = {
  nodes: Card[];
  edges: Edge[];
  boardId: string;
  jobs: GenerationJob[];
  assets: Asset[];
  documents: StudioDocument[];
  preview: Preview | undefined;
  /** The node whose run, or brief, is being submitted. */
  starting: string | null;
  startingBrief: string | null;
  /** Per node, whether its pick reflects its inputs, and the run held for it. */
  freshness: Record<string, Freshness>;
  pending: Record<string, PendingRun>;
};
export type Flow = {
  nodes: Card[];
  edges: Edge[];
  jobs: Map<string, NodeJobs>;
  ports: Map<string, PortInputs<InputRef>[]>;
};

const sameItems = <T>(a: T[], b: T[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);
/** Keeps `previous` when `next` holds the same items, so an unchanged list keeps its identity. */
const keep = <T>(previous: T[] | undefined, next: T[]) =>
  previous && sameItems(previous, next) ? previous : next;

/** Jobs grouped by the node they target on this board. Only groups whose jobs changed are new. */
function groupJobs(cache: FlowCache["jobs"], jobs: GenerationJob[], boardId: string) {
  if (cache.source === jobs && cache.boardId === boardId) return cache.groups;
  const byNode = new Map<string, GenerationJob[]>();
  for (const job of jobs) {
    if (job.target?.boardId !== boardId) continue;
    const list = byNode.get(job.target.nodeId) ?? [];
    list.push(job);
    byNode.set(job.target.nodeId, list);
  }
  const groups = new Map<string, NodeJobs>();
  for (const [id, list] of byNode) {
    const previous = cache.groups.get(id);
    const next: NodeJobs = {
      jobs: keep(
        previous?.jobs,
        list.filter((job) => !isReview(job) && !isJudge(job)),
      ),
      reviewJobs: keep(previous?.reviewJobs, list.filter(isReview)),
      judgeJobs: keep(previous?.judgeJobs, list.filter(isJudge)),
    };
    groups.set(
      id,
      previous &&
        previous.jobs === next.jobs &&
        previous.reviewJobs === next.reviewJobs &&
        previous.judgeJobs === next.judgeJobs
        ? previous
        : next,
    );
  }
  cache.source = jobs;
  cache.boardId = boardId;
  cache.groups = groups;
  return groups;
}

/** The kind of every node, kept as the same map while no node is added, removed, or retyped. */
function nodeKinds(cache: FlowCache, nodes: Card[]) {
  const previous = cache.kinds;
  const unchanged =
    previous.size === nodes.length &&
    nodes.every((node) => previous.get(node.id) === node.data.source.type);
  if (unchanged) return previous;
  cache.kinds = new Map(nodes.map((node) => [node.id, node.data.source.type]));
  return cache.kinds;
}

/** Each node's inputs on its model's ports; a node computes them again only when it or a kind changes. */
function nodePorts(cache: FlowCache, nodes: Card[], kinds: Map<string, NodeKind>) {
  const ports = new Map<string, PortInputs<InputRef>[]>();
  const seen = new Set<string>();
  const kindOf = (id: string) => kinds.get(id);
  for (const node of nodes) {
    const source = node.data.source;
    let entry = cache.ports.get(node.id);
    if (!entry || entry.source !== source || entry.kinds !== kinds) {
      entry = { source, kinds, ports: nodeInputs(source, kindOf) };
      cache.ports.set(node.id, entry);
    }
    ports.set(node.id, entry.ports);
    seen.add(node.id);
  }
  for (const id of cache.ports.keys()) if (!seen.has(id)) cache.ports.delete(id);
  return ports;
}

const dataKeys = [
  "source",
  "asset",
  "document",
  "preview",
  "jobs",
  "job",
  "busy",
  "briefing",
  "inputs",
  "reviewJobs",
  "freshness",
  "pending",
] as const satisfies readonly (keyof CardData)[];
const sameData = (a: CardData, b: CardData) => dataKeys.every((key) => a[key] === b[key]);

/**
 * The cards and edges to hand React Flow. A card whose node, jobs, output, and inputs did not
 * change is the object from last time; the same goes for an edge whose port and color held.
 */
export function prepareFlow(cache: FlowCache, input: FlowInput): Flow {
  const jobs = groupJobs(cache.jobs, input.jobs, input.boardId);
  const kinds = nodeKinds(cache, input.nodes);
  const ports = nodePorts(cache, input.nodes, kinds);
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
  const documents = new Map(input.documents.map((document) => [document.id, document]));
  const seen = new Set<string>();
  const nodes = input.nodes.map((node) => {
    const source = node.data.source;
    const group = jobs.get(node.id) ?? noJobs;
    const data: CardData = {
      source,
      asset: typeof source.data.assetId === "string" ? assets.get(source.data.assetId) : undefined,
      document:
        typeof source.data.documentId === "string"
          ? documents.get(source.data.documentId)
          : undefined,
      preview: input.preview,
      jobs: group.jobs,
      job: group.jobs[0],
      reviewJobs: group.reviewJobs,
      busy: nodeBusy(node.id, group, input.starting, input.startingBrief, input.pending[node.id]),
      briefing: nodeBriefing(node.id, group, input.startingBrief),
      inputs: ports.get(node.id),
      freshness: input.freshness[node.id],
      pending: input.pending[node.id],
    };
    seen.add(node.id);
    const previous = cache.cards.get(node.id);
    if (previous && previous.node === node && sameData(previous.card.data, data))
      return previous.card;
    const card: Card = { ...node, data };
    cache.cards.set(node.id, { node, card });
    return card;
  });
  for (const id of cache.cards.keys()) if (!seen.has(id)) cache.cards.delete(id);
  const edgeIds = new Set<string>();
  const edges = input.edges.map((edge) => {
    edgeIds.add(edge.id);
    // Wires are derived from inputs, so each carries the port it lands on.
    const handle = edge.targetHandle ?? null;
    const stroke = kindInfo(kinds.get(edge.source)).color;
    const previous = cache.edges.get(edge.id);
    if (
      previous &&
      previous.edge === edge &&
      previous.handle === handle &&
      previous.stroke === stroke
    )
      return previous.shown;
    const shown: Edge = {
      ...edge,
      targetHandle: handle,
      style: { stroke, strokeWidth: edge.selected ? 3 : 2 },
    };
    cache.edges.set(edge.id, { edge, handle, stroke, shown });
    return shown;
  });
  for (const id of cache.edges.keys()) if (!edgeIds.has(id)) cache.edges.delete(id);
  return { nodes, edges, jobs, ports };
}
