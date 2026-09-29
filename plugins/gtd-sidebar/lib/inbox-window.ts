import type { InboxShelf, VisibleInboxRow } from "./inbox-tree.ts";
import { groupCollapseKey, type ProjectGroup } from "./project-groups.ts";

/**
 * The list as the window sees it: every shelf header, project header and row
 * in the order they draw, flattened. Headers always mount; only rows are
 * windowed. The flat order is what the virtualizer measures and places, so
 * the render must walk the same shelves, groups and rows in the same order.
 */
export type InboxWindowItem =
  | { kind: "shelf"; key: string }
  | { kind: "group"; key: string }
  | { kind: "row"; key: string; row: VisibleInboxRow; shelf: InboxShelf };

/** One shelf as the list draws it. */
export interface InboxShelfLayout {
  shelf: InboxShelf;
  /** False folds the shelf to its header. */
  expanded: boolean;
  groups: readonly ProjectGroup[];
}

export interface InboxWindowLayout {
  items: readonly InboxWindowItem[];
  /** A shelf's or a group's header index, keyed by `shelfKey` or `groupCollapseKey`. */
  headerIndex: ReadonlyMap<string, number>;
  /** The index of the first row under a group, or under an ungrouped shelf. */
  rowsStart: ReadonlyMap<string, number>;
}

export function shelfKey(shelf: InboxShelf): string {
  return `shelf:${shelf}`;
}

/** The container a row list hangs off: its group, or the shelf when ungrouped. */
export function rowsKey(shelf: InboxShelf, projectId: string | null): string {
  return projectId === null ? shelfKey(shelf) : groupCollapseKey(shelf, projectId);
}

export function buildInboxWindow(
  shelves: readonly InboxShelfLayout[],
  grouped: boolean,
  groupExpanded: (key: string) => boolean,
): InboxWindowLayout {
  const items: InboxWindowItem[] = [];
  const headerIndex = new Map<string, number>();
  const rowsStart = new Map<string, number>();
  const pushRows = (shelf: InboxShelf, key: string, rows: readonly VisibleInboxRow[]) => {
    rowsStart.set(key, items.length);
    for (const row of rows) {
      items.push({ kind: "row", key: `row:${row.node.thread.id}`, row, shelf });
    }
  };
  for (const { shelf, expanded, groups } of shelves) {
    if (groups.length === 0) continue;
    headerIndex.set(shelfKey(shelf), items.length);
    items.push({ kind: "shelf", key: shelfKey(shelf) });
    if (!expanded) continue;
    if (!grouped) {
      pushRows(
        shelf,
        shelfKey(shelf),
        groups.flatMap((group) => group.rows),
      );
      continue;
    }
    for (const group of groups) {
      const key = groupCollapseKey(shelf, group.projectId);
      headerIndex.set(key, items.length);
      items.push({ kind: "group", key });
      if (groupExpanded(key)) pushRows(shelf, key, group.rows);
    }
  }
  return { items, headerIndex, rowsStart };
}

/** A run of a container's rows: mounted one by one, or folded into one placeholder. */
export type InboxWindowSegment =
  | { kind: "row"; offset: number }
  | { kind: "placeholder"; from: number; to: number };

/**
 * Splits a container's rows, `count` of them from flat index `start`, into
 * the rows that mount and the runs between them that a placeholder stands in
 * for. `from` and `to` are offsets into the container, `to` exclusive.
 */
export function windowSegments(
  start: number,
  count: number,
  mounted: ReadonlySet<number>,
): InboxWindowSegment[] {
  const segments: InboxWindowSegment[] = [];
  let runFrom: number | null = null;
  for (let offset = 0; offset < count; offset += 1) {
    if (mounted.has(start + offset)) {
      if (runFrom !== null) segments.push({ kind: "placeholder", from: runFrom, to: offset });
      runFrom = null;
      segments.push({ kind: "row", offset });
    } else {
      runFrom ??= offset;
    }
  }
  if (runFrom !== null) segments.push({ kind: "placeholder", from: runFrom, to: count });
  return segments;
}

/**
 * bb's next/previous-thread keys walk the mounted row anchors and, for rows a
 * window leaves out, the `data-sidebar-windowed-nav` placeholders between
 * them: space-separated `threadId:projectId` pairs in list order.
 */
export function encodeWindowedNav(rows: readonly VisibleInboxRow[]): string {
  return rows.map(({ node }) => `${node.thread.id}:${node.thread.projectId}`).join(" ");
}

/**
 * bb numbers its jump keys over the first nine mounted row anchors in DOM
 * order. Keeping the list's first nine rows mounted keeps ⌘1–⌘9 on the same
 * threads they reach with every row mounted, wherever the list is scrolled.
 */
export const JUMP_KEY_ROWS = 9;

/**
 * Rows that stay mounted outside the window: the jump-key rows, and any the
 * user is working with (the open thread, the row being dragged, the row that
 * holds focus, such as an open rename).
 */
export function pinnedRowIndexes(
  items: readonly InboxWindowItem[],
  threadIds: readonly (string | null | undefined)[],
): number[] {
  const wanted = new Set(threadIds.filter((id): id is string => typeof id === "string"));
  const pinned: number[] = [];
  let rows = 0;
  items.forEach((item, index) => {
    if (item.kind !== "row") return;
    if (rows < JUMP_KEY_ROWS || wanted.has(item.row.node.thread.id)) pinned.push(index);
    rows += 1;
  });
  return pinned;
}

/**
 * A first guess at an item's height, margin included, for rows that have not
 * mounted yet. The numbers mirror the stylesheet (app.css, the row
 * components); a mounted item is measured and its real height replaces this.
 */
export function estimateInboxItemSize(
  item: InboxWindowItem,
  { isCompactViewport, compactThreads }: { isCompactViewport: boolean; compactThreads: boolean },
): number {
  // Rows and project headers sit 2px below whatever precedes them.
  const gap = 2;
  switch (item.kind) {
    case "shelf":
      return isCompactViewport ? 40 : 24;
    case "group":
      return (isCompactViewport ? 40 : 32) + gap;
    case "row": {
      const slim = item.shelf === "snoozed" || item.shelf === "settled";
      if (isCompactViewport) return (slim ? 44 : 40) + gap;
      if (slim || compactThreads || item.row.depth > 0) return 32 + gap;
      return 52 + gap;
    }
  }
}
