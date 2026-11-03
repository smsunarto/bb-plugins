// Folds GTD stores against their defaults, so a shelf or group that starts
// folded needs no seeding: an absent key is the default, and toggling back to
// the default drops the key again.
import type { ShelfId } from "../../shared/preferences.ts";
import type { SidebarThread } from "../model/sidebar-thread.ts";

/** SlopCop's automated work, the snoozed, and the settled are out of the way until asked for. */
const SHELVES_FOLDED_BY_DEFAULT: ReadonlySet<ShelfId> = new Set(["slopcop", "snoozed", "settled"]);

export type FoldOverrides = Readonly<Record<string, boolean | undefined>>;

export function shelfStartsFolded(shelf: ShelfId): boolean {
  return SHELVES_FOLDED_BY_DEFAULT.has(shelf);
}

export function isShelfFolded(folds: FoldOverrides, shelf: ShelfId): boolean {
  return folds[shelf] ?? shelfStartsFolded(shelf);
}

export function groupFoldKey(shelf: ShelfId, groupKey: string): string {
  return `${shelf} ${groupKey}`;
}

/** Settled groups start folded: the shelf is a look-back, opened one project at a time. */
export function groupStartsFolded(shelf: ShelfId): boolean {
  return shelf === "settled";
}

export function isGroupFolded(folds: FoldOverrides, shelf: ShelfId, groupKey: string): boolean {
  return folds[groupFoldKey(shelf, groupKey)] ?? groupStartsFolded(shelf);
}

/** The overrides with `key` set to `folded`, or without it when that is the default. */
export function withFold<T extends FoldOverrides>(
  folds: T,
  key: string,
  folded: boolean,
  startsFolded: boolean,
): T {
  if ((folds[key] ?? startsFolded) === folded) return folds;
  const next: Record<string, boolean | undefined> = { ...folds };
  if (folded === startsFolded) delete next[key];
  else next[key] = folded;
  return next as T;
}

/**
 * Families start folded: every parent is collapsed unless the user opened it.
 * `expanded` holds those choices.
 */
export function collapsedParents(
  threads: readonly SidebarThread[],
  expanded: readonly string[],
): Set<string> {
  const open = new Set(expanded);
  const listed = new Set(threads.map((thread) => thread.id));
  const collapsed = new Set<string>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId;
    if (parentId !== null && listed.has(parentId) && !open.has(parentId)) collapsed.add(parentId);
  }
  return collapsed;
}

/**
 * `expanded` with `threadId` toggled. Ids of threads no longer listed are
 * dropped on the way, so the preference never outgrows the list.
 */
export function toggleExpanded(
  expanded: readonly string[],
  threadId: string,
  listed: ReadonlySet<string>,
): string[] {
  const kept = expanded.filter((id) => id !== threadId && listed.has(id));
  return expanded.includes(threadId) ? kept : [...kept, threadId];
}
