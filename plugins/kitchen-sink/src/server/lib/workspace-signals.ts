import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { WORKSPACE_CHANGED_CHANNEL, type WorkspaceChangedSignal } from "../../shared/contract.ts";

/**
 * Tell every connected app when a thread's workspace may have changed, so the
 * app can free or refresh the embeds it cached for that thread.
 */
export function registerWorkspaceSignals(bb: BbPluginApi): void {
  const publish = (
    thread: { id: string; parentThreadId: string | null },
    reason: WorkspaceChangedSignal["reason"],
  ) => {
    const signal: WorkspaceChangedSignal = {
      threadId: thread.id,
      parentThreadId: thread.parentThreadId,
      reason,
    };
    bb.realtime.publish(WORKSPACE_CHANGED_CHANNEL, signal);
  };
  bb.events.on("thread.idle", ({ thread }) => publish(thread, "idle"));
  bb.events.on("thread.failed", ({ thread }) => publish(thread, "failed"));
  bb.events.on("thread.archived", ({ thread }) => publish(thread, "archived"));
  bb.events.on("thread.deleted", ({ thread }) => publish(thread, "deleted"));
}
