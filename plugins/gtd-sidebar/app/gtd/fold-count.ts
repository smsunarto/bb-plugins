// What a folded folder shows in place of its rows, as GTD's own sidebar did:
// how many families it holds and how many of them need the user.
import type { SidebarThread } from "../model/sidebar-thread.js";

export interface FoldCount {
  /** Root families among the folder's rows. */
  families: number;
  /** Families with a status that asks for the user. */
  attention: number;
}

/** True when the thread's status glyph says the user is needed. */
export function needsUser(thread: SidebarThread): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.isUnread ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" ||
    thread.indicator === "unread-success"
  );
}

/**
 * A family is a thread whose parent is not among the rows, with every row
 * under it; it needs the user when any of its rows does, since the fold hides
 * them all.
 */
export function foldCount(threads: readonly SidebarThread[]): FoldCount {
  const parentOf = new Map(threads.map((thread) => [thread.id, thread.parentThreadId]));
  const rootOf = (threadId: string): string => {
    let current = threadId;
    const seen = new Set<string>();
    for (;;) {
      const parent = parentOf.get(current);
      if (parent === null || parent === undefined || !parentOf.has(parent) || seen.has(parent)) {
        return current;
      }
      seen.add(current);
      current = parent;
    }
  };
  const families = new Map<string, boolean>();
  for (const thread of threads) {
    const root = rootOf(thread.id);
    families.set(root, families.get(root) === true || needsUser(thread));
  }
  let attention = 0;
  for (const needs of families.values()) if (needs) attention += 1;
  return { families: families.size, attention };
}

/** The count as a screen reader should say it; the visible `2 / 5` reads "2 slash 5". */
export function spokenFoldCount({ families, attention }: FoldCount): string {
  const threads = `${families} ${families === 1 ? "thread" : "threads"}`;
  if (attention <= 0) return threads;
  return `${threads}, ${attention} ${attention === 1 ? "needs" : "need"} you`;
}
