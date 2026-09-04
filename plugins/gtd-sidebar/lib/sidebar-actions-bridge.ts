import type { PluginSidebarThreadActions } from "@get-bb/plugin-sdk/app";

// The palette row is registered at app definition time, outside React, while
// the host's archive action only exists inside a hook. The mounted inbox
// publishes its copy here so the palette can reach it.
let current: PluginSidebarThreadActions | null = null;

export function publishSidebarActions(actions: PluginSidebarThreadActions): void {
  current = actions;
}

export function forgetSidebarActions(actions: PluginSidebarThreadActions): void {
  if (current === actions) current = null;
}

export function hasSidebarActions(): boolean {
  return current !== null;
}

export function archiveThread(threadId: string): void {
  current?.archive(threadId);
}
