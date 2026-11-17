import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TaskThreadLiveStatus } from "../db";

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

/**
 * A task thread's live status from bb's thread row. Archived wins over the run
 * status, so the event path and the reconcile agree on an archived thread that
 * had failed; a deleted thread is terminal unless it last failed.
 */
export function liveStatusFromThread(thread: SdkThread): TaskThreadLiveStatus {
  // Loose checks: a partial thread row without the field reads as not archived.
  if (thread.archivedAt != null && thread.deletedAt == null) return "archived";
  if (thread.status === "error") return "failed";
  if (thread.deletedAt != null) return "completed";
  switch (thread.status) {
    case "pending":
    case "starting":
      return "starting";
    case "active":
    case "stopping":
      return "working";
    case "idle":
      return "idle";
  }
}
