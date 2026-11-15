import type { PluginSidebarThread, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";

/**
 * bb's own Archive. Settle stands in for it on every row, so the row menus
 * leave it out and the settle dispatcher runs it, confirmation included.
 */
export const ARCHIVE_ACTION_KEY = "bb--core/archive";

/**
 * Actions the touch sheet leaves out, so a long press offers only the moves
 * that matter on a phone. The desktop right-click menu keeps them all.
 */
export const SHEET_HIDDEN_ACTION_KEYS: ReadonlySet<string> = new Set([
  "bb--core/copyLink",
  "bb--core/newThreadInEnvironment",
  "bb--core/read",
  "bb--core/rename",
  "bb--core/regenerateTitle",
  "push-notifications/notifications",
]);

/** The fields bb's thread actions read, copied from a sidebar row. */
export function toThreadActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const environment = thread.environment;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      environment?.id == null ? null : { id: environment.id, path: environment.path ?? null },
  };
}
