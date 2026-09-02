import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { isThreadWorking } from "./lifecycle.ts";

/** Most recently updated thread first for every sidebar section. */
export function sortByUpdatedAtDescending<
  T extends { readonly id: string; readonly createdAt: number; readonly updatedAt: number },
>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.id.localeCompare(right.id),
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

/** Split active threads by owner and sort both sections newest first. */
export function partitionActiveSections(threads: readonly PluginSidebarThread[]): {
  nextAction: PluginSidebarThread[];
  waiting: PluginSidebarThread[];
} {
  const nextAction: PluginSidebarThread[] = [];
  const waiting: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (activeSectionFor(thread) === "next-action" ? nextAction : waiting).push(thread);
  }
  return {
    nextAction: sortByUpdatedAtDescending(nextAction),
    waiting: sortByUpdatedAtDescending(waiting),
  };
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
 * The row that should receive focus when the active thread leaves its section.
 *
 * Prefer the row below it. When the settled row was last, use the row above so
 * focus still leaves the archived thread. A settle from an unfocused row must
 * not move the user's current thread.
 */
export function nextThreadIdAfterSettle<T extends { readonly id: string }>(
  sectionThreads: readonly T[],
  settledThreadId: string,
  activeThreadId: string | null,
): string | null {
  if (settledThreadId !== activeThreadId) return null;
  const settledIndex = sectionThreads.findIndex((thread) => thread.id === settledThreadId);
  if (settledIndex === -1) return null;
  return sectionThreads[settledIndex + 1]?.id ?? sectionThreads[settledIndex - 1]?.id ?? null;
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
