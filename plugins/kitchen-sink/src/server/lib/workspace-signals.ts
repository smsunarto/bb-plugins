import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { WORKSPACE_CHANGED_CHANNEL, type WorkspaceChangedSignal } from "../../shared/contract.ts";

/**
 * Publish thread lifecycle signals for browser completion sounds.
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
}
