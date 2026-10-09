import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { WORKSPACE_CHANGED_CHANNEL, type WorkspaceChanged } from "../../shared/panel.ts";

/**
 * An agent's writes come in a burst that ends with its turn. Saying so lets an
 * open panel show them now rather than on its next poll. Panels listen by
 * environment, not by thread, because a Create PR or Resolve conflicts
 * subthread writes to its parent's environment. The thread and its parent
 * ride along for the panel to tell its own turns from a sibling's. A thread
 * with no environment changed no workspace.
 */
export function publishWorkspaceChanged(
  bb: Pick<BbPluginApi, "realtime">,
  thread: { id: string; environmentId: string | null; parentThreadId: string | null },
): void {
  if (thread.environmentId === null) return;
  const payload: WorkspaceChanged = {
    environmentId: thread.environmentId,
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
  };
  bb.realtime.publish(WORKSPACE_CHANGED_CHANNEL, payload);
}
