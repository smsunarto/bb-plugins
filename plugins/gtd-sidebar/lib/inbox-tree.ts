import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { activeSectionFor } from "./inbox.ts";

export type InboxLifecycle = "active" | "snoozed" | "settled";
/**
 * The shelves GTD draws below bb's own Pinned section. Pinned threads and
 * their descendants never reach this model: bb's Pinned list owns them.
 */
export type InboxShelf = "nextAction" | "waiting" | "slopcop" | "snoozed" | "settled";

/** The plugin id bb stamps on threads SlopCop dispatches for its GitHub rules. */
const SLOPCOP_PLUGIN_ID = "slopcop";

export interface InboxThreadNode {
  thread: PluginSidebarThread;
  lifecycle: InboxLifecycle;
  children: InboxThreadNode[];
  shelf: InboxShelf;
  /** When this thread last arrived on the shelf it sits on. Roots sort by it. */
  shelfEnteredAt: number;
  statusThread: PluginSidebarThread;
}

function statusPriority(thread: PluginSidebarThread): number {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return 5;
  if (thread.indicator === "unread-error") return 4;
  if (
    thread.queuedWork === "waiting" ||
    (thread.indicator !== "none" && thread.indicator !== "unread-success")
  )
    return 2;
  return 0;
}

function ownShelf(thread: PluginSidebarThread, lifecycle: InboxLifecycle): InboxShelf {
  if (lifecycle !== "active") return lifecycle;
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
  /** Clock for stamping shelf moves this build observes. */
  now?: number;
}

interface ResolvedSort {
  arrivals: ShelfArrivals;
  snoozedAtFor(thread: PluginSidebarThread): number | null;
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
        ? thread.archivedAt
        : null;
  const seed = exact ?? (shelf === "nextAction" ? thread.latestAttentionAt : thread.updatedAt);
  // Track parked shelves too, so leaving one restamps the next arrival.
  const tracked = sort.arrivals.enteredAt(thread.id, shelf, seed, sort.now);
  return exact ?? tracked;
}

function createInboxNode(
  thread: PluginSidebarThread,
  lifecycleFor: (thread: PluginSidebarThread) => InboxLifecycle,
  sort: ResolvedSort,
): InboxThreadNode {
  const lifecycle = thread.isArchived ? "settled" : lifecycleFor(thread);
  const shelf = ownShelf(thread, lifecycle);
  return {
    thread,
    lifecycle,
    children: [],
    shelf,
    shelfEnteredAt: shelfEnteredAt(thread, shelf, sort),
    statusThread: thread,
  };
}

function linkedParentIds(nodes: ReadonlyMap<string, InboxThreadNode>): Map<string, string> {
  const parents = new Map<string, string>();
  for (const node of nodes.values()) {
    // bb's own parent link, forks included: the Thread list nests a fork
    // under its source, so shelving must keep the same family.
    const parentId = node.thread.parentThreadId;
    if (
      parentId &&
      parentId !== node.thread.id &&
      nodes.get(parentId)?.lifecycle === node.lifecycle
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
      if (statusPriority(child.statusThread) > statusPriority(node.statusThread))
        node.statusThread = child.statusThread;
    }
    node.shelf = familyShelf(node);
  }
}

/**
 * SlopCop's automated reviews and triages share one shelf, apart from the
 * user's own work, whether they run or rest. Only the family's root decides:
 * a SlopCop thread nested under the user's work still counts toward that
 * family like any child. A raised hand stays in Next Action, where a folded
 * shelf cannot hide it.
 */
function rootShelf(node: InboxThreadNode): InboxShelf {
  if (node.thread.originPluginId !== SLOPCOP_PLUGIN_ID) return node.shelf;
  if (node.shelf === "waiting") return "slopcop";
  return node.shelf === "nextAction" && statusPriority(node.statusThread) < 5
    ? "slopcop"
    : node.shelf;
}

/**
 * A family is one unit of work. Any live descendant keeps the whole family in
 * waiting; only a raised hand somewhere in the family brings it back to the
 * user.
 */
function familyShelf(node: InboxThreadNode): InboxShelf {
  if (node.shelf !== "nextAction" && node.shelf !== "waiting") return node.shelf;
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
    nextAction: 0,
    waiting: 1,
    slopcop: 2,
    snoozed: 3,
    settled: 4,
  };
  // One comparator for every shelf: the family's shelf, then its place on
  // it, most recent arrival first, then creation time and id.
  return (a: InboxThreadNode, b: InboxThreadNode) => {
    const shelfDelta = shelfOrder[a.shelf] - shelfOrder[b.shelf];
    if (shelfDelta !== 0) return shelfDelta;
    return (
      b.shelfEnteredAt - a.shelfEnteredAt ||
      b.thread.createdAt - a.thread.createdAt ||
      a.thread.id.localeCompare(b.thread.id)
    );
  };
}

export function buildInboxTree(
  threads: readonly PluginSidebarThread[],
  lifecycleFor: (thread: PluginSidebarThread) => InboxLifecycle,
  sort: InboxSort = {},
): InboxThreadNode[] {
  const resolved: ResolvedSort = {
    arrivals: sort.arrivals ?? createShelfArrivals(),
    snoozedAtFor: sort.snoozedAtFor ?? (() => null),
    now: sort.now ?? Date.now(),
  };
  const nodes = new Map(
    threads.map((thread) => [thread.id, createInboxNode(thread, lifecycleFor, resolved)]),
  );
  const parents = linkedParentIds(nodes);
  const roots: InboxThreadNode[] = [];
  for (const node of nodes.values()) {
    const parentId = parents.get(node.thread.id);
    if (parentId) nodes.get(parentId)!.children.push(node);
    else roots.push(node);
  }
  aggregateFamilies(roots);
  for (const root of roots) root.shelf = rootShelf(root);
  return roots.sort(familyComparator());
}
