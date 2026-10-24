import type { PluginSidebarThread, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";

/**
 * bb's own Archive. Settle stands in for it on every row, so the row menus
 * leave it out and the settle dispatcher runs it, confirmation included.
 */
export const ARCHIVE_ACTION_KEY = "bb--core/archive";

/** The fields bb's thread actions read, copied from a sidebar row. */
export function toThreadActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const environment = thread.environment;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      environment?.id == null ? null : { id: environment.id, path: environment.path ?? null },
  };
}
