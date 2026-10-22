import { filterNodeReferences } from "../shared/node-references.ts";
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
      const data = filterNodeReferences(node.data, (id) => ids.has(id));
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

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && equal(left[key], right[key]))
  );
};
/** Keys the local draft changed since `base` come from `local`; the rest come from `remote`. */
function mergeRecord<T extends object>(base: T | undefined, local: T, remote: T): T {
  const merged: Record<string, unknown> = { ...(remote as Record<string, unknown>) };
  const b = (base ?? {}) as unknown as Record<string, unknown>,
    l = local as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(l), ...Object.keys(b)])) {
    if (equal(l[key], b[key])) continue;
    if (key in l) merged[key] = l[key];
    else delete merged[key];
  }
  return merged as unknown as T;
}
/** Merge items by id: local additions and deletions win, as do fields the draft changed. */
function mergeById<T extends { id: string }>(
  base: T[],
  local: T[],
  remote: T[],
  merge: (base: T | undefined, local: T, remote: T) => T,
): T[] {
  const byId = (items: T[]) => new Map(items.map((item) => [item.id, item]));
  const b = byId(base),
    l = byId(local),
    r = byId(remote);
  return [
    ...local.flatMap((item) => {
      const theirs = r.get(item.id);
      if (theirs) return [merge(b.get(item.id), item, theirs)];
      return b.has(item.id) ? [] : [item];
    }),
    ...remote.filter((item) => !l.has(item.id) && !b.has(item.id)),
  ];
}
/**
 * Rebase the local draft onto a newer saved board. Generation results, agents and other
 * tabs write the board on disk; unsaved local edits stay on top of their changes.
 */
export function rebaseBoard(base: Board, local: Board, remote: Board): Board {
  const nodes = mergeById(base.nodes, local.nodes, remote.nodes, (b, l, r) => ({
    ...mergeRecord(b, l, r),
    data: mergeRecord(b?.data, l.data, r.data),
  }));
  const ids = new Set(nodes.map((node) => node.id));
  const layout = mergeRecord(
    base.editorLayout.nodes,
    local.editorLayout.nodes,
    remote.editorLayout.nodes,
  );
  return {
    ...mergeRecord(base, local, remote),
    nodes,
    edges: mergeById(base.edges, local.edges, remote.edges, (b, l, r) => (equal(l, b) ? r : l)),
    editorLayout: {
      ...mergeRecord(base.editorLayout, local.editorLayout, remote.editorLayout),
      nodes: Object.fromEntries(Object.entries(layout).filter(([id]) => ids.has(id))),
    },
  };
}
