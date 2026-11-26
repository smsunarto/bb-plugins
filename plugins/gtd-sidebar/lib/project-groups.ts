import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { arrayMove } from "@dnd-kit/sortable";
import type { InboxShelf, InboxThreadNode, VisibleInboxRow } from "./inbox-tree.ts";
import { isLongLivedThread } from "./long-lived.ts";

export interface ProjectGroup {
  projectId: string;
  rows: VisibleInboxRow[];
  /** Root families in the group, whatever their children's projects. */
  families: number;
  /** Families whose status asks for the user. */
  attention: number;
}

/** True when the row's status glyph says the user is needed. */
export function needsUser(thread: PluginSidebarThread): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.isUnread ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" ||
    thread.indicator === "unread-success"
  );
}

/**
 * True when a root family needs the user while its project group is folded.
 * Long-lived parents (Captains) ignore crew `isUnread` so a running crew child
 * with a stale recovered-error unread flag does not inflate the group count.
 */
function familyNeedsUser(node: InboxThreadNode): boolean {
  const status = node.statusThread;
  return (
    status.hasPendingInteraction ||
    status.indicator === "waiting-for-input" ||
    status.indicator === "unread-error" ||
    status.indicator === "unread-success" ||
    (isLongLivedThread(node.thread) ? node.hasUnread : status.isUnread)
  );
}

/**
 * One group per root project, in bb's project order: the `projects` array the
 * host hands the sidebar is already sorted by each project's `sortKey`, so
 * every shelf — and `bb project list` — agrees on one canonical order and a
 * reorder made from any group header lands identically everywhere. Rows
 * inside a group keep the shelf's own sort, and children follow their root
 * whatever project they belong to.
 *
 * Threads without a real project (bb files them under the implicit personal
 * project) are the exception: their group always trails the project groups,
 * and bb will not reorder the personal project, so nothing can move it.
 * A project missing from the order — a stale thread view, mostly — sorts
 * after every known project and before the personal one.
 */
export function groupRowsByProject(
  rows: readonly VisibleInboxRow[],
  projectOrder: readonly string[] = [],
  isProjectless: (projectId: string) => boolean = () => false,
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  let current: ProjectGroup | null = null;
  for (const row of rows) {
    if (row.depth === 0 || current === null) {
      const projectId = row.node.thread.projectId;
      current = groups.get(projectId) ?? null;
      if (current === null) {
        current = { projectId, rows: [], families: 0, attention: 0 };
        groups.set(projectId, current);
      }
      current.families += 1;
      // The family's loudest status, not the root's own: the count shows while
      // the group is folded, where the whole family is out of sight.
      if (familyNeedsUser(row.node)) current.attention += 1;
    }
    current.rows.push(row);
  }
  const rank = new Map(projectOrder.map((projectId, index) => [projectId, index]));
  // Stable, so projects missing from the order keep their row order.
  const ordered = [...groups.values()].sort(
    (a, b) =>
      (rank.get(a.projectId) ?? projectOrder.length) -
      (rank.get(b.projectId) ?? projectOrder.length),
  );
  return [
    ...ordered.filter((group) => !isProjectless(group.projectId)),
    ...ordered.filter((group) => isProjectless(group.projectId)),
  ];
}

export type ProjectMoveDirection = "up" | "down";

/**
 * `bb.sdk.projects.reorder` arguments for moving a project past the group
 * next to it in one shelf.
 *
 * The neighbour is the adjacent group in the shelf, so one click is one
 * visible move; the anchors come from bb's full project order, so the write
 * lands the same no matter which shelf it was made from. Null when the move
 * cannot run: no group on that side, or either project is missing from bb's
 * order — the personal project is never in it, which is what keeps it pinned
 * to the bottom and immovable.
 */
export function projectReorderArgs(
  projectId: string,
  direction: ProjectMoveDirection,
  shelfOrder: readonly string[],
  projectOrder: readonly string[],
): { previousProjectId: string | null; nextProjectId: string | null } | null {
  if (!projectOrder.includes(projectId)) return null;
  const at = shelfOrder.indexOf(projectId);
  const neighbourId =
    at < 0 ? undefined : direction === "up" ? shelfOrder[at - 1] : shelfOrder[at + 1];
  if (neighbourId === undefined) return null;
  const to = projectOrder.indexOf(neighbourId);
  if (to < 0) return null;
  // `at` and `to` order the same way — shelf order is project order filtered
  // to the groups it shows — so the moved id can never sit on the picked side
  // of the neighbour.
  return direction === "up"
    ? { previousProjectId: projectOrder[to - 1] ?? null, nextProjectId: neighbourId }
    : { previousProjectId: neighbourId, nextProjectId: projectOrder[to + 1] ?? null };
}

export type ProjectDropEdge = "before" | "after";

/**
 * Which side of the drop target the dragged group lands on. In a vertical
 * sortable list `arrayMove` seats the dragged item at the target's index, so
 * dropping onto a group below it lands after that group and onto one above
 * lands before it. Null when either index is unknown or the drop is on the
 * dragged group itself.
 */
export function projectDropEdge(activeIndex: number, overIndex: number): ProjectDropEdge | null {
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return null;
  return activeIndex < overIndex ? "after" : "before";
}

/**
 * `bb.sdk.projects.reorder` arguments for a group header dropped onto another
 * group in a shelf — the drag counterpart of `projectReorderArgs`.
 *
 * `edge` is the side of `overProjectId` the header lands on, and the anchors
 * come from bb's full project order, so a project the shelf does not show is
 * jumped identically from every shelf. Null when the drop cannot run: either
 * project missing from bb's order (the personal project is never in it), the
 * header dropped on itself, or the spot it would land is the one it already
 * holds.
 */
export function projectDropReorderArgs(
  projectId: string,
  overProjectId: string,
  edge: ProjectDropEdge,
  projectOrder: readonly string[],
): { previousProjectId: string | null; nextProjectId: string | null } | null {
  const from = projectOrder.indexOf(projectId);
  const to = projectOrder.indexOf(overProjectId);
  if (from < 0 || to < 0 || from === to) return null;
  const without = projectOrder.filter((id) => id !== projectId);
  const at = to > from ? to - 1 : to;
  const insertAt = edge === "before" ? at : at + 1;
  // insertAt in the shortened order is also the dragged project's own slot,
  // so equality means the drop asks for the place it already has.
  if (insertAt === from) return null;
  return {
    previousProjectId: without[insertAt - 1] ?? null,
    nextProjectId: without[insertAt] ?? null,
  };
}

/**
 * The order a resolved drop predicts: the dragged project moved to the slot
 * the anchors describe. Drawn in place of bb's order until the host's
 * project-order-changed publish lands — the prediction every shelf mirrors —
 * and dropped the moment the real order arrives.
 */
export function applyProjectMove(
  projectOrder: readonly string[],
  projectId: string,
  args: { previousProjectId: string | null; nextProjectId: string | null },
): string[] {
  const without = projectOrder.filter((id) => id !== projectId);
  const insertAt =
    args.nextProjectId === null ? without.length : without.indexOf(args.nextProjectId);
  return arrayMove([...projectOrder], projectOrder.indexOf(projectId), insertAt);
}

/**
 * Settle one optimistic project move from bb's authoritative response. The
 * identity check keeps a slower response from replacing a newer drag.
 */
export function settleProjectOrderOverride(
  current: readonly string[] | null,
  optimistic: readonly string[],
  canonical: readonly string[] | null,
): readonly string[] | null {
  return current === optimistic ? canonical : current;
}

/**
 * A dropped group's predicted order, made against bb's order at the time of
 * the drop. It stands in for bb's order until bb republishes `projects`.
 */
export interface ProjectOrderOverride {
  readonly base: readonly string[];
  readonly order: readonly string[];
}

/** The order to draw: the override while bb's order is the one it was made against. */
export function overriddenProjectOrder(
  override: ProjectOrderOverride | null,
  projectOrder: readonly string[],
): readonly string[] {
  return override?.base === projectOrder ? override.order : projectOrder;
}

/**
 * Settle the drop made against `base` from bb's response. An override made
 * against another order, or by a newer drop, is left alone.
 */
export function settleProjectOrderDrop(
  current: ProjectOrderOverride | null,
  base: readonly string[],
  optimistic: readonly string[],
  canonical: readonly string[] | null,
): ProjectOrderOverride | null {
  if (current?.base !== base) return current;
  const settled = settleProjectOrderOverride(current.order, optimistic, canonical);
  if (settled === current.order) return current;
  return settled === null ? null : { base, order: settled };
}

export function groupCollapseKey(shelf: InboxShelf, projectId: string): string {
  return `${shelf} ${projectId}`;
}

/** Settled groups start folded: the shelf is a look-back, opened one project at a time. */
export function groupStartsCollapsed(key: string): boolean {
  return key.startsWith(groupCollapseKey("settled", ""));
}

/** Group headers earn their space only once a second project shows up. */
export function shouldGroupByProject(
  shelves: Readonly<Record<InboxShelf, readonly VisibleInboxRow[]>>,
): boolean {
  const projectIds = new Set<string>();
  for (const [shelf, rows] of Object.entries(shelves)) {
    // Captains render flat on their own shelf, so their project never earns
    // group headers for the remaining shelves.
    if (shelf === "captains") continue;
    for (const row of rows) {
      if (row.depth === 0) projectIds.add(row.node.thread.projectId);
      if (projectIds.size > 1) return true;
    }
  }
  return false;
}
