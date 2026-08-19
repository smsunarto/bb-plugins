import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { isThreadWorking } from "./lifecycle.ts";

/**
 * The static sort for user-controlled shelves: newest thread on top.
 *
 * Ties break on id so the order is total and stable across renders.
 */
export function sortByCreatedAtDescending<
  T extends { readonly id: string; readonly createdAt: number },
>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

export type ActiveSection = "next-action" | "waiting";

/**
 * The active section whose next move can change the thread.
 *
 * A pending interaction always needs the user, even when background work is
 * still live. Otherwise any foreground or background work means the user is
 * waiting for the agent; a quiet thread is ready for the user's next action.
 */
export function activeSectionFor(thread: PluginSidebarThread): ActiveSection {
  return thread.hasPendingInteraction || !isThreadWorking(thread) ? "next-action" : "waiting";
}

interface ActiveSectionOrderEntry {
  section: ActiveSection;
  sequence: number;
}

/**
 * Mounted-list entrance order for the two active sections.
 *
 * The SDK has no historical section-entry timestamp. `updatedAt` is therefore
 * only the deterministic first-mount seed and batch tie-breaker; after that,
 * sequence changes only when a thread enters a section.
 */
export interface ActiveSectionOrder {
  entries: ReadonlyMap<string, ActiveSectionOrderEntry>;
  nextSequence: number;
}

function compareInitialEntrance(left: PluginSidebarThread, right: PluginSidebarThread): number {
  return (
    left.updatedAt - right.updatedAt ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Reconcile every active, unpinned thread against its mounted-list order.
 *
 * Callers must pass the unfiltered active set. Project scope, search, and child
 * hiding affect presentation only and must not look like section exits.
 */
export function reconcileActiveSectionOrder(
  current: ActiveSectionOrder | null,
  threads: readonly PluginSidebarThread[],
): ActiveSectionOrder {
  const entries = new Map<string, ActiveSectionOrderEntry>();
  const entrants: PluginSidebarThread[] = [];
  let nextSequence = current?.nextSequence ?? 0;

  for (const thread of threads) {
    const section = activeSectionFor(thread);
    const existing = current?.entries.get(thread.id);
    if (existing?.section === section) entries.set(thread.id, existing);
    else entrants.push(thread);
  }

  entrants.sort(compareInitialEntrance);
  for (const thread of entrants) {
    entries.set(thread.id, {
      section: activeSectionFor(thread),
      sequence: nextSequence++,
    });
  }

  return { entries, nextSequence };
}

/** Split visible active threads and retain their mounted entrance order. */
export function partitionActiveSections(
  threads: readonly PluginSidebarThread[],
  order: ActiveSectionOrder,
): {
  nextAction: PluginSidebarThread[];
  waiting: PluginSidebarThread[];
} {
  const nextAction: PluginSidebarThread[] = [];
  const waiting: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (activeSectionFor(thread) === "next-action" ? nextAction : waiting).push(thread);
  }
  const byEntrance = (left: PluginSidebarThread, right: PluginSidebarThread) =>
    (order.entries.get(left.id)?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (order.entries.get(right.id)?.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id);
  nextAction.sort(byEntrance);
  waiting.sort(byEntrance);
  return { nextAction, waiting };
}

export function threadDisplayTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
}

/** Substring match on the visible title only, preserving the incoming order. */
export function searchThreadsByTitle(
  threads: readonly PluginSidebarThread[],
  query: string,
): PluginSidebarThread[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...threads];
  return threads.filter((thread) => threadDisplayTitle(thread).toLowerCase().includes(normalized));
}

export interface ProjectScope {
  /** Project id, or null for "all projects". */
  id: string | null;
  name: string;
}

/** Threads in the chosen scope; every thread when the scope is null. */
export function filterByProject(
  threads: readonly PluginSidebarThread[],
  projectId: string | null,
): PluginSidebarThread[] {
  if (projectId === null) return [...threads];
  return threads.filter((thread) => thread.projectId === projectId);
}

/**
 * Archived threads never belong in the inbox — except the ones this plugin
 * parked, which it archives itself.
 *
 * Settling a thread archives it in bb, so leaving the flag alone to decide
 * visibility would empty the settled shelf the instant anything landed on it.
 * A parked row is the plugin saying "I put it there", and that outranks the
 * archive it set.
 */
export function visibleInboxThreads(
  threads: readonly PluginSidebarThread[],
  parkedThreadIds: ReadonlySet<string>,
): PluginSidebarThread[] {
  return threads.filter((thread) => !thread.isArchived || parkedThreadIds.has(thread.id));
}

/** Pinned first (they are the user's own ordering), then the static sort. */
export function partitionPinned(threads: readonly PluginSidebarThread[]): {
  pinned: PluginSidebarThread[];
  inbox: PluginSidebarThread[];
} {
  const pinned: PluginSidebarThread[] = [];
  const inbox: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (thread.isPinned ? pinned : inbox).push(thread);
  }
  return { pinned, inbox };
}

/**
 * Child threads leave the flat list and live in their parent's header chip
 * instead — a flat inbox has nowhere to nest them.
 *
 * A child is only hidden when its parent is actually on screen. An orphan
 * (parent archived, deleted, or filtered out by the project scope) stays in
 * the list, because hiding it would make it unreachable everywhere.
 */
export function hideChildrenOfVisibleParents(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  const visibleIds = new Set(threads.map((thread) => thread.id));
  return threads.filter(
    (thread) => thread.parentThreadId === null || !visibleIds.has(thread.parentThreadId),
  );
}

/**
 * The parent of one thread, or null when the thread is a root, when the id is
 * unknown, or when the parent row is gone (deleted). The parent may be
 * archived or in another project: the flat list hides those, but the child
 * still needs a way back to them.
 */
export function parentOf(
  threads: readonly PluginSidebarThread[],
  threadId: string,
): PluginSidebarThread | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const parentThreadId = thread?.parentThreadId;
  if (!parentThreadId) return null;
  return threads.find((candidate) => candidate.id === parentThreadId) ?? null;
}

/** The children of one thread, oldest first (the order they were spawned). */
export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
): PluginSidebarThread[] {
  return threads
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .sort((left, right) => left.createdAt - right.createdAt);
}
