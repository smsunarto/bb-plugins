import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { isThreadWorking } from "./lifecycle.ts";

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

export function threadDisplayTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
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

export function effectiveParentThreadId(thread: PluginSidebarThread): string | null {
  return thread.originKind === "fork" ? null : thread.parentThreadId;
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
  const parentThreadId = thread ? effectiveParentThreadId(thread) : null;
  if (!parentThreadId) return null;
  return threads.find((candidate) => candidate.id === parentThreadId) ?? null;
}

/** The children of one thread, oldest first (the order they were spawned). */
export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
): PluginSidebarThread[] {
  return threads
    .filter((thread) => effectiveParentThreadId(thread) === parentThreadId)
    .sort((left, right) => left.createdAt - right.createdAt);
}
