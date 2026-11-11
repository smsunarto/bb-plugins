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
import { exportForCutover, exportForCutoverContract } from "./rpc/export-for-cutover.ts";
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
import { createThreadPullRequests } from "./rpc/thread-pull-requests.ts";
import { pullRequestContract } from "../shared/pull-request-contract.ts";

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
  // The pull request of each thread's GitButler branch, read by the composer
  // and Info surfaces and by other plugins (GTD Sidebar).
  ...pullRequestContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: GitButlerContext = Object.freeze({ bb });
  const pullRequests = createThreadPullRequests(bb);
  bb.onDispose(() => pullRequests.dispose());
  // Read-only, for Source Control's import at the cutover: storage is per plugin id.
  bb.rpc.register(
    defineRpcContract({ exportForCutover: exportForCutoverContract }),
    { exportForCutover: () => exportForCutover(ctx) },
    { experimental_discoverable: true },
  );
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
    threadPullRequests: ({ keys }) => pullRequests.read(keys),
    refreshThreadPullRequest: async ({ threadId }) => {
      await pullRequests.refresh(threadId);
      return { ok: true as const };
    },
    threadPullRequestAction: ({ threadId, action, url, headRefOid }) =>
      pullRequests.act(threadId, action, { url, headRefOid }),
  });
  bb.rpc.experimental_whileWatched("threadPullRequests", (read, signal) => {
    if ("key" in read) pullRequests.watch(read.key, signal);
  });

  bb.onDispose(relayRepositoryChanges(bb));
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => {
      void pullRequests.turnEnded(thread.id, thread.environmentId).catch((error: unknown) => {
        bb.log.debug(`Could not read the branch of ${thread.id}: ${String(error)}`);
      });
      return publishWorkspaceChanged(bb, thread);
    });
  }
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
