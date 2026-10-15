import type { Edge, Viewport } from "@xyflow/react";
import type { Board, CanvasNode } from "../shared/schema.ts";

/** Build the persisted board from the draft, dropping references to removed nodes. */
export function boardSnapshot(
  board: Board,
  nodes: CanvasNode[],
  edges: Edge[],
  viewport: Viewport,
): Board {
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...board,
    nodes: nodes.map((node) => {
      const data = { ...node.data };
      for (const key of ["images", "references"]) {
        if (Array.isArray(data[key])) {
          data[key] = data[key].filter(
            (ref) =>
              typeof ref !== "object" ||
              ref === null ||
              Array.isArray(ref) ||
              ref.type !== "node" ||
              ids.has(String(ref.nodeId)),
          );
        }
      }
      return Object.assign({}, node, { data });
    }),
    edges: edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map(({ id, source, target, sourceHandle }) => {
        const edge: Board["edges"][number] = { id, source, target };
        if (sourceHandle) edge.sourceHandle = sourceHandle;
        return edge;
      }),
    editorLayout: {
      ...board.editorLayout,
      fitView: false,
      viewport,
      nodes: Object.fromEntries(
        nodes.map((node) => [node.id, { ...board.editorLayout.nodes[node.id], ...node.position }]),
      ),
    },
  };
}
