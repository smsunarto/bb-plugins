/**
 * The Settled shelf's window over bb's archive.
 *
 * Settling is bb's archive. The host's sidebar view reports archived threads
 * when asked for the `"archived"` lifecycle, newest archive first, one page at
 * a time. These functions decide which of those rows the shelf draws and when
 * an older page is worth asking for. They are pure so they can be tested
 * without a bb server.
 */
import type { PluginSidebarThread, PluginSidebarThreadsState } from "@get-bb/plugin-sdk/app";

/**
 * How far back the Settled shelf reaches.
 *
 * A shelf that keeps everything ever archived is bb's archive with extra steps
 * — it grows without bound and buries the one thing the shelf is for: undoing
 * a settle you regret. A day covers "I filed that this morning" and keeps the
 * shelf readable.
 *
 * Nothing is unarchived when a thread ages out. It stops being drawn here and
 * stays exactly where it is, in bb's archived view.
 */
export const SETTLED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether an archive is recent enough to still be drawn on the shelf. */
export function isWithinSettledWindow(
  settledAt: number,
  now: number,
  windowMs: number = SETTLED_WINDOW_MS,
): boolean {
  // A stamp in the future — a clock that moved — is kept rather than hidden.
  // Losing a row the user just made would be the worse failure.
  return settledAt > now - windowMs;
}

/** Whether the list draws this thread: every active thread, and a settle inside the window. */
export function isShelvedThread(thread: PluginSidebarThread, now: number): boolean {
  if (!thread.isArchived) return true;
  return thread.archivedAt !== null && isWithinSettledWindow(thread.archivedAt, now);
}

/**
 * Whether the shelf should ask the host for the next, older archive page.
 *
 * bb hands the archive out newest first, so once one loaded archive falls
 * outside the window every later page is older still and nothing more is
 * fetched. A page already in flight or one that failed is left alone: the
 * host retries the failure on its own schedule, and a loop on top of it would
 * hammer the server.
 */
export function needsOlderArchivePage(
  threads: readonly PluginSidebarThread[],
  archived: PluginSidebarThreadsState["experimental_archived"],
  now: number,
): boolean {
  if (archived === null || archived.status !== "ready") return false;
  if (!archived.hasNextPage || archived.isFetchingNextPage || archived.isFetchNextPageError) {
    return false;
  }
  return threads.every((thread) => !thread.isArchived || isShelvedThread(thread, now));
}
