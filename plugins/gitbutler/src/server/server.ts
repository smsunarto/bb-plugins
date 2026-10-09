import { definePlugin } from "@bb-kit/core/plugin";
import { offerPanelTab } from "./lib/panel-tab.ts";
import { publishWorkspaceChanged } from "./lib/workspace-signal.ts";
import { baseHistory } from "./rpc/base-history.ts";
import { butAction } from "./rpc/but-action.ts";
import { conflictResolution } from "./rpc/conflict-resolution.ts";
import { oplog } from "./rpc/oplog.ts";
import { parkedBranches } from "./rpc/parked-branches.ts";
import { patches } from "./rpc/patches.ts";
import { repositories } from "./rpc/repositories.ts";
import { requestReview } from "./rpc/request-review.ts";
import { resolveConflicts } from "./rpc/resolve-conflicts.ts";
import { reviewRequests } from "./rpc/review-requests.ts";
import { reviewUrl } from "./rpc/review-url.ts";
import { reviews } from "./rpc/reviews.ts";
import { workspace } from "./rpc/workspace.ts";

export default definePlugin({
  pluginId: "gitbutler",
  rpc: {
    repositories,
    workspace,
    baseHistory,
    patches,
    butAction,
    requestReview,
    reviewRequests,
    reviewUrl,
    reviews,
    oplog,
    parkedBranches,
    resolveConflicts,
    conflictResolution,
  },
  setup({ bb }) {
    bb.events.on("thread.idle", ({ thread }) => publishWorkspaceChanged(bb, thread));
    bb.events.on("thread.failed", ({ thread }) => publishWorkspaceChanged(bb, thread));
    // `active` rather than `created`: a new thread's environment is still
    // provisioning when it is created, so there is no workspace to check yet.
    bb.events.on("thread.active", async ({ thread }) => {
      try {
        await offerPanelTab(bb, thread.id);
      } catch (error) {
        bb.log.warn(`Could not add the GitButler tab to ${thread.id}: ${String(error)}`);
      }
    });
  },
});
