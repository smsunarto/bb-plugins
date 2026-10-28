import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { GitButlerContext } from "./lib/context.ts";
import { offerPanelTab } from "./lib/panel-tab.ts";
import { publishWorkspaceChanged, relayRepositoryChanges } from "./lib/workspace-signal.ts";
import { baseHistory, baseHistoryContract } from "./rpc/base-history.ts";
import { branchBlobChunk, branchBlobChunkContract } from "./rpc/branch-blob-chunk.ts";
import { branchBlobs, branchBlobsContract } from "./rpc/branch-blobs.ts";
import { branchPatches, branchPatchesContract } from "./rpc/branch-patches.ts";
import { butAction, butActionContract } from "./rpc/but-action.ts";
import { checkoutChatTarget, checkoutChatTargetContract } from "./rpc/checkout-chat-target.ts";
import { conflictResolution, conflictResolutionContract } from "./rpc/conflict-resolution.ts";
import { oplog, oplogContract } from "./rpc/oplog.ts";
import { otherMachines, otherMachinesContract } from "./rpc/other-machines.ts";
import { parkedBranches, parkedBranchesContract } from "./rpc/parked-branches.ts";
import { patches, patchesContract } from "./rpc/patches.ts";
import { repositories, repositoriesContract } from "./rpc/repositories.ts";
import { requestReview, requestReviewContract } from "./rpc/request-review.ts";
import { resolveConflicts, resolveConflictsContract } from "./rpc/resolve-conflicts.ts";
import { reviewRequests, reviewRequestsContract } from "./rpc/review-requests.ts";
import { reviewUrl, reviewUrlContract } from "./rpc/review-url.ts";
import { reviews, reviewsContract } from "./rpc/reviews.ts";
import {
  unpublishedBranchesAt,
  unpublishedBranchesAtContract,
} from "./rpc/unpublished-branches-at.ts";
import { unpublishedBranches, unpublishedBranchesContract } from "./rpc/unpublished-branches.ts";
import { workspace, workspaceContract } from "./rpc/workspace.ts";

export const contract = defineRpcContract({
  repositories: repositoriesContract,
  workspace: workspaceContract,
  baseHistory: baseHistoryContract,
  patches: patchesContract,
  butAction: butActionContract,
  checkoutChatTarget: checkoutChatTargetContract,
  requestReview: requestReviewContract,
  reviewRequests: reviewRequestsContract,
  reviewUrl: reviewUrlContract,
  reviews: reviewsContract,
  oplog: oplogContract,
  parkedBranches: parkedBranchesContract,
  otherMachines: otherMachinesContract,
  resolveConflicts: resolveConflictsContract,
  conflictResolution: conflictResolutionContract,
  // Read by other plugins (Code Review), not by the board.
  unpublishedBranches: unpublishedBranchesContract,
  unpublishedBranchesAt: unpublishedBranchesAtContract,
  branchPatches: branchPatchesContract,
  branchBlobs: branchBlobsContract,
  branchBlobChunk: branchBlobChunkContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: GitButlerContext = Object.freeze({ bb });
  bb.rpc.register(contract, {
    repositories: (input) => repositories(ctx, input),
    workspace: (input) => workspace(ctx, input),
    baseHistory: (input) => baseHistory(ctx, input),
    patches: (input) => patches(ctx, input),
    butAction: (input) => butAction(ctx, input),
    checkoutChatTarget: (input) => checkoutChatTarget(ctx, input),
    requestReview: (input) => requestReview(ctx, input),
    reviewRequests: (input) => reviewRequests(ctx, input),
    reviewUrl: (input) => reviewUrl(ctx, input),
    reviews: (input) => reviews(ctx, input),
    oplog: (input) => oplog(ctx, input),
    parkedBranches: (input) => parkedBranches(ctx, input),
    otherMachines: (input) => otherMachines(ctx, input),
    resolveConflicts: (input) => resolveConflicts(ctx, input),
    conflictResolution: (input) => conflictResolution(ctx, input),
    unpublishedBranches: () => unpublishedBranches(ctx),
    unpublishedBranchesAt: (input) => unpublishedBranchesAt(ctx, input),
    branchPatches: (input) => branchPatches(ctx, input),
    branchBlobs: (input) => branchBlobs(ctx, input),
    branchBlobChunk: (input) => branchBlobChunk(ctx, input),
  });

  bb.onDispose(relayRepositoryChanges(bb));
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
}
