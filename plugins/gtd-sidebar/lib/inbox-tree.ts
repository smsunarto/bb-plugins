import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { activeSectionFor, effectiveParentThreadId, threadDisplayTitle } from "./inbox.ts";

export type InboxLifecycle = "active" | "snoozed" | "settled";
export type InboxShelf = "pinned" | "nextAction" | "waiting" | "snoozed" | "settled";

export interface InboxThreadNode {
  thread: PluginSidebarThread;
  lifecycle: InboxLifecycle;
  children: InboxThreadNode[];
  shelf: InboxShelf;
  attentionAt: number;
  updatedAt: number;
  statusThread: PluginSidebarThread;
  matchesSearch: boolean;
  matchesTitle: boolean;
}

export interface VisibleInboxRow {
  node: InboxThreadNode;
  depth: number;
  parentId: string | null;
  parentProjectId: string | null;
  parentTitle: string | null;
  expanded: boolean;
  guides: string;
  lastChild: boolean;
  statusThread: PluginSidebarThread;
}

function statusPriority(thread: PluginSidebarThread): number {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return 5;
  if (thread.indicator === "unread-error") return 4;
  if (thread.isUnread || thread.indicator === "unread-success") return 3;
  if (thread.indicator !== "none") return 2;
  return 0;
}

function ownShelf(thread: PluginSidebarThread, lifecycle: InboxLifecycle): InboxShelf {
  if (lifecycle !== "active") return lifecycle;
  if (thread.isPinned) return "pinned";
  return activeSectionFor(thread) === "next-action" ? "nextAction" : "waiting";
}

function createInboxNode(
  thread: PluginSidebarThread,
  lifecycleFor: (thread: PluginSidebarThread) => InboxLifecycle,
  normalizedQuery: string,
): InboxThreadNode {
  const lifecycle = thread.isArchived ? "settled" : lifecycleFor(thread);
  const matchesTitle = threadDisplayTitle(thread).toLowerCase().includes(normalizedQuery);
  return {
    thread,
    lifecycle,
    children: [],
    shelf: ownShelf(thread, lifecycle),
    attentionAt: thread.latestAttentionAt,
    updatedAt: thread.updatedAt,
    statusThread: thread,
    matchesSearch: matchesTitle,
    matchesTitle,
  };
}

function activeParentIds(nodes: ReadonlyMap<string, InboxThreadNode>): Map<string, string> {
  const parents = new Map<string, string>();
  for (const node of nodes.values()) {
    const parentId = effectiveParentThreadId(node.thread);
    if (
      parentId &&
      parentId !== node.thread.id &&
      node.lifecycle === "active" &&
      nodes.get(parentId)?.lifecycle === "active"
    ) {
      parents.set(node.thread.id, parentId);
    }
  }
  const resolved = new Set<string>();
  for (const id of nodes.keys()) {
    const path = new Set<string>();
    let cursor: string | undefined = id;
    while (cursor !== undefined && !resolved.has(cursor)) {
      if (path.has(cursor)) {
        parents.delete(cursor);
        break;
      }
      path.add(cursor);
      cursor = parents.get(cursor);
    }
    for (const entry of path) resolved.add(entry);
  }
  return parents;
}

function aggregateFamilies(roots: readonly InboxThreadNode[]): void {
  const preorder: InboxThreadNode[] = [];
  const stack = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    node.children.sort(
      (a, b) => a.thread.createdAt - b.thread.createdAt || a.thread.id.localeCompare(b.thread.id),
    );
    preorder.push(node);
    stack.push(...node.children);
  }
  for (let index = preorder.length - 1; index >= 0; index--) {
    const node = preorder[index]!;
    for (const child of node.children) {
      if (child.shelf === "pinned") node.shelf = "pinned";
      else if (
        node.shelf === "waiting" &&
        (child.shelf === "nextAction" || statusPriority(child.statusThread) >= 3)
      )
        node.shelf = "nextAction";
      node.attentionAt = Math.max(node.attentionAt, child.attentionAt);
      node.updatedAt = Math.max(node.updatedAt, child.updatedAt);
      node.matchesSearch ||= child.matchesSearch;
      if (statusPriority(child.statusThread) > statusPriority(node.statusThread))
        node.statusThread = child.statusThread;
    }
  }
}

function familyComparator() {
  const shelfOrder: Record<InboxShelf, number> = {
    pinned: 0,
    nextAction: 1,
    waiting: 2,
    snoozed: 3,
    settled: 4,
  };
  return (a: InboxThreadNode, b: InboxThreadNode) => {
    if (a.shelf !== b.shelf) return shelfOrder[a.shelf] - shelfOrder[b.shelf];
    if (a.shelf === "settled" && b.shelf === "settled") return 0;
    const clock = a.shelf === "waiting" && b.shelf === "waiting" ? "updatedAt" : "attentionAt";
    return (
      b[clock] - a[clock] ||
      b.thread.createdAt - a.thread.createdAt ||
      a.thread.id.localeCompare(b.thread.id)
    );
  };
}

export function buildInboxTree(
  threads: readonly PluginSidebarThread[],
  lifecycleFor: (thread: PluginSidebarThread) => InboxLifecycle,
  query = "",
): InboxThreadNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  const nodes = new Map(
    threads.map((thread) => [thread.id, createInboxNode(thread, lifecycleFor, normalizedQuery)]),
  );
  const parents = activeParentIds(nodes);
  const roots: InboxThreadNode[] = [];
  for (const node of nodes.values()) {
    const parentId = parents.get(node.thread.id);
    if (parentId) nodes.get(parentId)!.children.push(node);
    else roots.push(node);
  }
  aggregateFamilies(roots);
  return roots.sort(familyComparator());
}

export function visibleInboxRows(
  roots: readonly InboxThreadNode[],
  collapsed: ReadonlySet<string>,
  query = "",
): VisibleInboxRow[] {
  const searching = query.trim().length > 0;
  const rows: VisibleInboxRow[] = [];
  const stack = roots
    .filter((node) => node.matchesSearch)
    .map((node) => ({
      node,
      depth: 0,
      parentId: null,
      parentProjectId: null,
      parentTitle: null,
      guides: "",
      lastChild: false,
      ancestorMatches: false,
    }))
    .reverse() as (Omit<VisibleInboxRow, "expanded" | "statusThread"> & {
    ancestorMatches: boolean;
  })[];
  while (stack.length) {
    const row = stack.pop()!;
    const ancestorMatches = row.ancestorMatches || row.node.matchesTitle;
    const children = row.node.children.filter((child) => ancestorMatches || child.matchesSearch);
    const expanded = children.length > 0 && (searching || !collapsed.has(row.node.thread.id));
    rows.push({
      ...row,
      expanded,
      statusThread: expanded ? row.node.thread : row.node.statusThread,
    });
    if (!expanded) continue;
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({
        ancestorMatches,
        node: children[index]!,
        depth: row.depth + 1,
        parentId: row.node.thread.id,
        parentProjectId: row.node.thread.projectId,
        parentTitle: threadDisplayTitle(row.node.thread),
        guides: row.depth === 0 ? "" : row.guides + (row.lastChild ? "0" : "1"),
        lastChild: index === children.length - 1,
      });
    }
  }
  return rows;
}
