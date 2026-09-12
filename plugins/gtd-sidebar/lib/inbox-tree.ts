import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { activeSectionFor, effectiveParentThreadId, threadDisplayTitle } from "./inbox.ts";

export type InboxLifecycle = "active" | "snoozed" | "settled";
export type InboxShelf = "pinned" | "nextAction" | "waiting" | "snoozed" | "settled";

export interface InboxThreadNode {
  thread: PluginSidebarThread;
  lifecycle: InboxLifecycle;
  children: InboxThreadNode[];
  shelf: InboxShelf;
  /** When this thread last arrived on the shelf it sits on. Roots sort by it. */
  shelfEnteredAt: number;
  /**
   * The family's place in bb's pinned order: the pin `sortKey` of its
   * shallowest pinned member, matching the root bb's own pinned sidebar
   * would list. Null when no member is pinned or the keys have not loaded.
   */
  pinOrderKey: string | null;
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

/**
 * When each thread last arrived on its current shelf, remembered for the
 * session.
 *
 * bb's own clocks can't answer it: `updatedAt` ticks on renames, pins, and
 * read-state writes, and `latestAttentionAt` on turn ends — neither means
 * "came to rest here". So the first build seeds a thread's stamp from the bb
 * timestamp that fired its arrival (a turn start bumps `updatedAt`; a
 * finished turn or an attention request bumps `latestAttentionAt`), and a
 * shelf move observed between builds restamps it at the caller's clock.
 * While the shelf stays the same the frozen stamp wins, however bb's clocks
 * move.
 *
 * Every node's own shelf is tracked, not every family's: a child promoted to
 * root keeps the stamp it earned while parked under its parent, and a thread
 * that parks and comes back re-enters at the top instead of reclaiming its
 * old place.
 */
export interface ShelfArrivals {
  enteredAt(threadId: string, shelf: InboxShelf, seedAt: number, now: number): number;
}

export function createShelfArrivals(): ShelfArrivals {
  const arrivals = new Map<string, { shelf: InboxShelf; at: number }>();
  return {
    enteredAt(threadId, shelf, seedAt, now) {
      const existing = arrivals.get(threadId);
      if (existing !== undefined && existing.shelf === shelf) return existing.at;
      const at = existing === undefined ? seedAt : now;
      arrivals.set(threadId, { shelf, at });
      return at;
    },
  };
}

export interface InboxSort {
  /**
   * Session memory of shelf arrivals. Pass a persistent one so stamps stay
   * frozen across builds; omitted, every build seeds fresh from bb's clocks.
   */
  arrivals?: ShelfArrivals;
  /** The lifecycle row's `snoozedAt` — the Snoozed shelf's exact arrival. */
  snoozedAtFor?: (thread: PluginSidebarThread) => number | null;
  /** bb's `archivedAt` — the Settled shelf's exact arrival. */
  settledAtFor?: (thread: PluginSidebarThread) => number | null;
  /**
   * bb's `pinSortKey` for the thread — the Pinned shelf's order, shared with
   * the built-in sidebar's drag order. Null while the keys are still loading.
   */
  pinOrderKeyFor?: (thread: PluginSidebarThread) => string | null;
  /** Clock for stamping shelf moves this build observes. */
  now?: number;
}

interface ResolvedSort {
  arrivals: ShelfArrivals;
  snoozedAtFor(thread: PluginSidebarThread): number | null;
  settledAtFor(thread: PluginSidebarThread): number | null;
  pinOrderKeyFor(thread: PluginSidebarThread): string | null;
  now: number;
}

/**
 * The thread's sortable age: when it arrived on the shelf it sits on.
 *
 * Snoozed and Settled already record their arrival — the snooze row's
 * `snoozedAt` and bb's `archivedAt` — and the key reads them live rather than
 * frozen, so a re-snooze or a second settle lands back on top. The active
 * shelves have no such timestamp, so theirs come from arrival memory: a shelf
 * change re-enters at the top, and anything short of it leaves the row put.
 */
function shelfEnteredAt(
  thread: PluginSidebarThread,
  shelf: InboxShelf,
  sort: ResolvedSort,
): number {
  const exact =
    shelf === "snoozed"
      ? sort.snoozedAtFor(thread)
      : shelf === "settled"
        ? sort.settledAtFor(thread)
        : null;
  const seed =
    exact ??
    (shelf === "nextAction" || shelf === "pinned" ? thread.latestAttentionAt : thread.updatedAt);
  // Track parked shelves too, so leaving one restamps the next arrival.
  const tracked = sort.arrivals.enteredAt(thread.id, shelf, seed, sort.now);
  return exact ?? tracked;
}

function createInboxNode(
  thread: PluginSidebarThread,
  lifecycleFor: (thread: PluginSidebarThread) => InboxLifecycle,
  normalizedQuery: string,
  sort: ResolvedSort,
): InboxThreadNode {
  const lifecycle = thread.isArchived ? "settled" : lifecycleFor(thread);
  const shelf = ownShelf(thread, lifecycle);
  const matchesTitle = threadDisplayTitle(thread).toLowerCase().includes(normalizedQuery);
  return {
    thread,
    lifecycle,
    children: [],
    shelf,
    shelfEnteredAt: shelfEnteredAt(thread, shelf, sort),
    pinOrderKey: thread.isPinned ? sort.pinOrderKeyFor(thread) : null,
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
      node.matchesSearch ||= child.matchesSearch;
      if (statusPriority(child.statusThread) > statusPriority(node.statusThread))
        node.statusThread = child.statusThread;
    }
    // A pinned node's own key already decides the family — bb never lists a
    // thread under a pinned ancestor — so descendants only contribute when
    // the node itself is unpinned, and then their most prominent key wins.
    node.pinOrderKey ??= node.children.reduce<string | null>(
      (best, child) => minPinOrderKey(best, child.pinOrderKey),
      null,
    );
    node.shelf = familyShelf(node);
  }
}

/** The earlier of two pin sort keys; a null loses to any known key. */
function minPinOrderKey(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

/**
 * A family is one unit of work. Any live descendant keeps the whole family in
 * waiting; only a raised hand somewhere in the family brings it back to the
 * user, and a pinned descendant pins the family.
 */
function familyShelf(node: InboxThreadNode): InboxShelf {
  if (node.shelf !== "nextAction" && node.shelf !== "waiting") {
    return node.children.some((child) => child.shelf === "pinned") ? "pinned" : node.shelf;
  }
  if (node.children.some((child) => child.shelf === "pinned")) return "pinned";
  const needsUser =
    node.thread.hasPendingInteraction ||
    node.children.some(
      (child) => child.shelf === "nextAction" && statusPriority(child.statusThread) >= 5,
    );
  if (needsUser) return "nextAction";
  const working =
    node.shelf === "waiting" || node.children.some((child) => child.shelf === "waiting");
  return working ? "waiting" : "nextAction";
}

function familyComparator() {
  const shelfOrder: Record<InboxShelf, number> = {
    pinned: 0,
    nextAction: 1,
    waiting: 2,
    snoozed: 3,
    settled: 4,
  };
  // One comparator for every shelf: the family's shelf, then its place on
  // it — Pinned follows bb's own pin order, the rest take most recent
  // arrival first — then creation time and id.
  return (a: InboxThreadNode, b: InboxThreadNode) => {
    const shelfDelta = shelfOrder[a.shelf] - shelfOrder[b.shelf];
    if (shelfDelta !== 0) return shelfDelta;
    if (a.shelf === "pinned") {
      const pinDelta = comparePinOrderKeys(a.pinOrderKey, b.pinOrderKey);
      if (pinDelta !== 0) return pinDelta;
    }
    return (
      b.shelfEnteredAt - a.shelfEnteredAt ||
      b.thread.createdAt - a.thread.createdAt ||
      a.thread.id.localeCompare(b.thread.id)
    );
  };
}

/** Known keys first; an unloaded one keeps its arrival place below them. */
function comparePinOrderKeys(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildInboxTree(
  threads: readonly PluginSidebarThread[],
  lifecycleFor: (thread: PluginSidebarThread) => InboxLifecycle,
  query = "",
  sort: InboxSort = {},
): InboxThreadNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  const resolved: ResolvedSort = {
    arrivals: sort.arrivals ?? createShelfArrivals(),
    snoozedAtFor: sort.snoozedAtFor ?? (() => null),
    settledAtFor: sort.settledAtFor ?? (() => null),
    pinOrderKeyFor: sort.pinOrderKeyFor ?? (() => null),
    now: sort.now ?? Date.now(),
  };
  const nodes = new Map(
    threads.map((thread) => [
      thread.id,
      createInboxNode(thread, lifecycleFor, normalizedQuery, resolved),
    ]),
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
