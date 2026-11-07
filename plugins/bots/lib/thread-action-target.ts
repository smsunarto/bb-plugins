import type { PluginSidebarThread, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";

// A pending environment can have display metadata but no reusable ID yet.
export function threadActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  return {
    ...thread,
    environment: thread.environment?.id
      ? { id: thread.environment.id, path: thread.environment.path }
      : null,
  };
}
