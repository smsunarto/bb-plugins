import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { WORKSPACE_CHANGED_CHANNEL, type WorkspaceChangedSignal } from "../../shared/contract.ts";

/**
 * Tell every connected app when a thread's workspace may have changed, so the
 * app can free or refresh the embeds it cached for that thread.
 */
export function registerWorkspaceSignals(bb: BbPluginApi): void {
  const publish = (threadId: string, reason: WorkspaceChangedSignal["reason"]) => {
    const signal: WorkspaceChangedSignal = { threadId, reason };
    bb.realtime.publish(WORKSPACE_CHANGED_CHANNEL, signal);
  };
  bb.events.on("thread.idle", ({ thread }) => publish(thread.id, "idle"));
  bb.events.on("thread.failed", ({ thread }) => publish(thread.id, "failed"));
  bb.events.on("thread.archived", ({ thread }) => publish(thread.id, "archived"));
  bb.events.on("thread.deleted", ({ thread }) => publish(thread.id, "deleted"));
}
