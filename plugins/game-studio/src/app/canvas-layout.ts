import { Graph, layout } from "@dagrejs/dagre";
import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import type { Edge, Node, Rect, Viewport, XYPosition } from "@xyflow/react";

/** Lay out connected cards left to right, with loose cards in a grid below. */
export function arrangeNodes<T extends Pick<Node, "id" | "position" | "measured">>(
  nodes: T[],
  edges: Pick<Edge, "source" | "target">[],
): T[] {
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>();
  graph.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80, marginx: 40, marginy: 40 });
  graph.setDefaultEdgeLabel(() => ({}));
  const cards = nodes.map((node) => ({
    node,
    bounds: {
      width: node.measured?.width ?? 280,
      height: node.measured?.height ?? 300,
      x: 0,
      y: 0,
    },
  }));
  for (const { node, bounds } of cards) if (connected.has(node.id)) graph.setNode(node.id, bounds);
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  if (graph.nodeCount()) layout(graph);

  const loose = cards.filter(({ node }) => !connected.has(node.id));
  const columns = Math.ceil(Math.sqrt(loose.length));
  const columnWidth = Math.max(280, ...loose.map(({ bounds }) => bounds.width)) + 40;
  const rowHeight = Math.max(0, ...loose.map(({ bounds }) => bounds.height)) + 40;
  const bottom = cards.reduce(
    (end, { node, bounds }) =>
      connected.has(node.id) ? Math.max(end, bounds.y + bounds.height / 2) : end,
    0,
  );
  let index = 0;
  return cards.map(({ node, bounds }) => {
    const position = connected.has(node.id)
      ? { x: bounds.x - bounds.width / 2, y: bounds.y - bounds.height / 2 }
      : {
          x: 40 + (index % columns) * columnWidth,
          y: (bottom ? bottom + 80 : 40) + Math.floor(index++ / columns) * rowHeight,
        };
    return Object.assign({}, node, { position });
  });
}

/** Find an open spot near the view, keeping existing cards in place. */
export function newNodePosition(
  center: XYPosition,
  nodes: { position: XYPosition; measured?: { width?: number; height?: number } }[],
): XYPosition {
  // Reserve enough space for an expanded document before the new card is measured.
  const width = 280;
  const height = 300;
  const gap = 40;
  const origin = { x: center.x - width / 2, y: center.y - height / 2 };
  const occupied = nodes.map((node) => ({
    ...node.position,
    width: node.measured?.width ?? width,
    height: node.measured?.height ?? height,
  }));
  const candidates = [
    origin,
    ...occupied.flatMap((node) => [
      { x: node.x + node.width + gap, y: node.y },
      { x: node.x, y: node.y + node.height + gap },
      { x: node.x - width - gap, y: node.y },
      { x: node.x, y: node.y - height - gap },
    ]),
  ];
  const distance = (position: XYPosition) =>
    (position.x - origin.x) ** 2 + (position.y - origin.y) ** 2;
  candidates.sort((a, b) => distance(a) - distance(b));
  // The spot to the right of the rightmost card is always free.
  return candidates.find((position) =>
    occupied.every(
      (node) =>
        position.x + width + gap <= node.x ||
        position.x >= node.x + node.width + gap ||
        position.y + height + gap <= node.y ||
        position.y >= node.y + node.height + gap,
    ),
  )!;
}

/** Reveal an inspected card without changing the user's zoom. */
export function revealNode(
  view: Viewport,
  size: { width: number; height: number },
  node: Rect,
): Viewport {
  const reveal = (
    offset: number,
    start: number,
    length: number,
    available: number,
    before: number,
    after: number,
  ) => {
    const leading = before - start * view.zoom;
    if (length * view.zoom > available - before - after) return leading;
    return Math.max(leading, Math.min(offset, available - after - (start + length) * view.zoom));
  };
  // Leave room for the selected node's floating toolbar above and beside it.
  return {
    x: reveal(view.x, node.x, node.width, size.width, 96, 96),
    y: reveal(view.y, node.y, node.height, size.height, 120, 88),
    zoom: view.zoom,
  };
}
