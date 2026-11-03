// GTD's shelves over bb's Thread list. bb's Pinned section keeps its own rule
// (a pinned thread and everything under it); every other thread lands on one
// shelf with its whole family, and each shelf groups those families by the
// root's project or machine. The list renders each group with bb's own tree.
import type { InboxShelf, InboxThreadNode } from "../../lib/inbox-tree.ts";
import type { OrganizationMode, ShelfId } from "../../shared/preferences.ts";
import type { SidebarThread } from "../model/sidebar-thread.ts";
import type { ThreadComparator } from "../model/project-thread-groups.ts";

export const SHELF_ORDER: readonly InboxShelf[] = [
  "nextAction",
  "waiting",
  "slopcop",
  "snoozed",
  "settled",
];

export const SHELF_LABELS: Record<ShelfId, string> = {
  pinned: "Pinned",
  nextAction: "Next Action",
  waiting: "Waiting",
  slopcop: "SlopCop",
  snoozed: "Snoozed",
  settled: "Settled",
};

export const NO_MACHINE_KEY = "no-machine";

export interface ShelfGroup {
  /** The drag engine's section key: `project:<id>` or `machine:<id>`. */
  key: string;
  kind: "project" | "machine";
  /** The project id, or the root's machine id (`no-machine` without one). */
  id: string;
  /** Every thread of the group's families, children included. */
  threads: SidebarThread[];
}

export interface ShelfView {
  shelf: InboxShelf;
  /** Every thread on the shelf, children included. */
  threads: SidebarThread[];
  /** One per project or machine, in bb's order; empty when the list is flat. */
  groups: ShelfGroup[];
}

export interface ShelfLayout {
  /** Shelves that hold a thread, in draw order. */
  shelves: ShelfView[];
  /** Whether the shelves draw group headers. */
  grouped: boolean;
  shelfOf: ReadonlyMap<string, InboxShelf>;
  /** The group a thread draws under, whether or not headers show. */
  groupOf: ReadonlyMap<string, string>;
  /** The root of each thread's family on its shelf. */
  rootOf: ReadonlyMap<string, string>;
  /** When each thread arrived on its shelf; the arrival sort's key. */
  enteredAt: ReadonlyMap<string, number>;
}

export interface ShelfLayoutInput {
  /** `buildInboxTree` over every shelved thread outside Pinned. */
  forest: readonly InboxThreadNode[];
  mode: OrganizationMode;
  /** bb's project order, personal project left out. */
  projectOrder: readonly string[];
  personalProjectIds: ReadonlySet<string>;
  /** bb's known machines, in its order. */
  hostOrder: readonly string[];
  /** A machine filter is on: keep headers even for a single group. */
  forceGroups: boolean;
}

/**
 * The threads bb's Pinned section draws: each pinned thread still active on
 * GTD's terms, with every active thread under it. A pinned thread or a child
 * that was settled or snoozed goes to that shelf instead, so its own verbs
 * (Un-settle, Wake) stay with it.
 */
export function pinnedFamilyIds(
  threads: readonly SidebarThread[],
  isActive: (thread: SidebarThread) => boolean,
): Set<string> {
  const children = new Map<string, SidebarThread[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    const siblings = children.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else children.set(thread.parentThreadId, [thread]);
  }
  const pinned = new Set<string>();
  const stack = threads.filter((thread) => thread.pinnedAt !== null && isActive(thread));
  while (stack.length > 0) {
    const thread = stack.pop()!;
    if (pinned.has(thread.id)) continue;
    pinned.add(thread.id);
    stack.push(...(children.get(thread.id) ?? []).filter(isActive));
  }
  return pinned;
}

function familyThreads(root: InboxThreadNode): SidebarThread[] {
  const threads: SidebarThread[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    threads.push(node.thread);
    stack.push(...node.children);
  }
  return threads;
}

function rankOf(order: readonly string[]): (id: string) => number {
  const rank = new Map(order.map((id, index) => [id, index]));
  return (id) => rank.get(id) ?? order.length;
}

/**
 * Shelves, their groups, and the lookups the list, its reveal, and settle's
 * advance share. A family follows its root: a child on another machine or in
 * another project still draws under its parent.
 */
export function buildShelfLayout({
  forest,
  mode,
  projectOrder,
  personalProjectIds,
  hostOrder,
  forceGroups,
}: ShelfLayoutInput): ShelfLayout {
  const shelfOf = new Map<string, InboxShelf>();
  const groupOf = new Map<string, string>();
  const rootOf = new Map<string, string>();
  const enteredAt = new Map<string, number>();
  const byShelf = new Map<InboxShelf, Map<string, ShelfGroup>>();
  const threadsByShelf = new Map<InboxShelf, SidebarThread[]>();
  const groupKeys = new Set<string>();

  for (const root of forest) {
    const kind = mode === "machine" ? "machine" : "project";
    const id =
      kind === "machine" ? (root.thread.host?.id ?? NO_MACHINE_KEY) : root.thread.projectId;
    const key = `${kind}:${id}`;
    groupKeys.add(key);
    const members = familyThreads(root);
    let groups = byShelf.get(root.shelf);
    if (!groups) {
      groups = new Map();
      byShelf.set(root.shelf, groups);
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, kind, id, threads: [] };
      groups.set(key, group);
    }
    group.threads.push(...members);
    const shelfThreads = threadsByShelf.get(root.shelf);
    if (shelfThreads) shelfThreads.push(...members);
    else threadsByShelf.set(root.shelf, [...members]);
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      shelfOf.set(node.thread.id, root.shelf);
      groupOf.set(node.thread.id, key);
      rootOf.set(node.thread.id, root.thread.id);
      enteredAt.set(node.thread.id, node.shelfEnteredAt);
      stack.push(...node.children);
    }
  }

  const projectRank = rankOf(projectOrder);
  const hostRank = rankOf(hostOrder);
  const groupRank = (group: ShelfGroup): number => {
    if (group.kind === "project") {
      return personalProjectIds.has(group.id) ? Number.MAX_SAFE_INTEGER : projectRank(group.id);
    }
    return group.id === NO_MACHINE_KEY ? Number.MAX_SAFE_INTEGER : hostRank(group.id);
  };
  const grouped = mode !== "chronological" && (forceGroups || groupKeys.size > 1);
  const shelves = SHELF_ORDER.flatMap<ShelfView>((shelf) => {
    const threads = threadsByShelf.get(shelf);
    if (!threads) return [];
    const groups = grouped
      ? [...(byShelf.get(shelf)?.values() ?? [])].sort(
          (left, right) => groupRank(left) - groupRank(right) || left.id.localeCompare(right.id),
        )
      : [];
    return [{ shelf, threads, groups }];
  });
  return { shelves, grouped, shelfOf, groupOf, rootOf, enteredAt };
}

/**
 * GTD's arrival sort: a family's root by when it arrived on its shelf, newest
 * first, and children in the order they were made. `descending: false` puts
 * the oldest arrival first.
 */
export function createArrivalComparator(
  layout: Pick<ShelfLayout, "enteredAt" | "rootOf">,
  descending = true,
): ThreadComparator {
  const sign = descending ? 1 : -1;
  return (left, right) => {
    const leftIsRoot = layout.rootOf.get(left.id) === left.id;
    if (!leftIsRoot) {
      return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
    }
    const leftAt = layout.enteredAt.get(left.id) ?? left.updatedAt;
    const rightAt = layout.enteredAt.get(right.id) ?? right.updatedAt;
    return (
      sign * (rightAt - leftAt) ||
      sign * (right.createdAt - left.createdAt) ||
      left.id.localeCompare(right.id)
    );
  };
}
