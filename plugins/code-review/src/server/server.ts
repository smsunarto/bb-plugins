import { defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { playbook } from "./command/playbook.ts";
import { prompt } from "./command/prompt.ts";
import threeKitSource, { THREE_KIT_ETAG } from "../../vendor/three-kit.ts";
import { BLOB_PATH, THREE_KIT_PATH } from "../shared/blob-url.ts";
import { publishActivity } from "./lib/activity.ts";
import { serveBlob } from "./lib/blob-route.ts";
import { createBlobReader } from "./lib/blobs.ts";
import type { CodeReviewContext, CodeReviewServices } from "./lib/context.ts";
import { createGitHub } from "./lib/gh.ts";
import { createPrWatcher } from "./lib/pr-watch.ts";
import { createStore } from "./lib/store.ts";
import { reviewSkills } from "./lib/review-scope.ts";
import { createUnityPreviews } from "./lib/unity-preview.ts";
import { addDraftComment, addDraftCommentContract } from "./rpc/add-draft-comment.ts";
import { agentActivity, agentActivityContract } from "./rpc/agent-activity.ts";
import { branchActivity, branchActivityContract } from "./rpc/branch-activity.ts";
import { branchReviewed, branchReviewedContract } from "./rpc/branch-reviewed.ts";
import { setBranchViewed, setBranchViewedContract } from "./rpc/set-branch-viewed.ts";
import { changedFiles, changedFilesContract } from "./rpc/changed-files.ts";
import { checks, checksContract } from "./rpc/checks.ts";
import { fileBlobs, fileBlobsContract } from "./rpc/file-blobs.ts";
import { deleteDraft, deleteDraftContract } from "./rpc/delete-draft.ts";
import { discardReview, discardReviewContract } from "./rpc/discard-review.ts";
import { editDraft, editDraftContract } from "./rpc/edit-draft.ts";
import { fixChecksPrompt, fixChecksPromptContract } from "./rpc/fix-checks-prompt.ts";
import { inbox, inboxContract } from "./rpc/inbox.ts";
import { localBranch, localBranchContract } from "./rpc/local-branch.ts";
import { localBranches, localBranchesContract } from "./rpc/local-branches.ts";
import { localChanges, localChangesContract } from "./rpc/local-changes.ts";
import { sharedComparison, sharedComparisonContract } from "./rpc/shared-comparison.ts";
import { prWatches, prWatchesContract } from "./rpc/pr-watches.ts";
import { prActionState, prActionStateContract } from "./rpc/pr-action-state.ts";
import { prAction, prActionContract } from "./rpc/pr-action.ts";
import { pullRequest, pullRequestContract } from "./rpc/pull-request.ts";
import { replyDraft, replyDraftContract } from "./rpc/reply-draft.ts";
import { reviewInstructions, reviewInstructionsContract } from "./rpc/review-instructions.ts";
import { setPinned, setPinnedContract } from "./rpc/set-pinned.ts";
import {
  setReviewInstructions,
  setReviewInstructionsContract,
} from "./rpc/set-review-instructions.ts";
import { setViewed, setViewedContract } from "./rpc/set-viewed.ts";
import { startFix, startFixContract } from "./rpc/start-fix.ts";
import { startLocalReview, startLocalReviewContract } from "./rpc/start-local-review.ts";
import { startReview, startReviewContract } from "./rpc/start-review.ts";
import { status, statusContract } from "./rpc/status.ts";
import { stopPrWatch, stopPrWatchContract } from "./rpc/stop-pr-watch.ts";
import { submitReview, submitReviewContract } from "./rpc/submit-review.ts";
import { unityPreview, unityPreviewContract } from "./rpc/unity-preview.ts";
import { reportFindings, reportFindingsEnabled } from "./tools/report-findings.ts";
import { shareChanges } from "./tools/share-changes.ts";
import { watchPr, watchPrEnabled } from "./tools/watch-pr.ts";

export const contract = defineRpcContract({
  status: statusContract,
  inbox: inboxContract,
  pullRequest: pullRequestContract,
  prAction: prActionContract,
  prActionState: prActionStateContract,
  changedFiles: changedFilesContract,
  checks: checksContract,
  agentActivity: agentActivityContract,
  reviewInstructions: reviewInstructionsContract,
  setReviewInstructions: setReviewInstructionsContract,
  setPinned: setPinnedContract,
  setViewed: setViewedContract,
  addDraftComment: addDraftCommentContract,
  replyDraft: replyDraftContract,
  editDraft: editDraftContract,
  deleteDraft: deleteDraftContract,
  submitReview: submitReviewContract,
  discardReview: discardReviewContract,
  startReview: startReviewContract,
  fixChecksPrompt: fixChecksPromptContract,
  startFix: startFixContract,
  localBranch: localBranchContract,
  localBranches: localBranchesContract,
  localChanges: localChangesContract,
  sharedComparison: sharedComparisonContract,
  branchActivity: branchActivityContract,
  branchReviewed: branchReviewedContract,
  setBranchViewed: setBranchViewedContract,
  startLocalReview: startLocalReviewContract,
  fileBlobs: fileBlobsContract,
  unityPreview: unityPreviewContract,
  prWatches: prWatchesContract,
  stopPrWatch: stopPrWatchContract,
});

function createServices(bb: BbPluginApi): CodeReviewServices {
  const github = createGitHub();
  const blobs = createBlobReader({ bb, github });
  return {
    github,
    store: createStore(bb.storage.kv),
    blobs,
    unity: createUnityPreviews(blobs),
    watcher: createPrWatcher({ bb, github }),
  };
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: CodeReviewContext = Object.freeze({ bb, ...createServices(bb) });
  const { store, blobs, watcher } = ctx;
  bb.rpc.register(contract, {
    status: () => status(ctx),
    inbox: () => inbox(ctx),
    pullRequest: (input) => pullRequest(ctx, input),
    prAction: (input) => prAction(ctx, input),
    prActionState: (input) => prActionState(ctx, input),
    changedFiles: (input) => changedFiles(ctx, input),
    checks: (input) => checks(ctx, input),
    agentActivity: (input) => agentActivity(ctx, input),
    reviewInstructions: () => reviewInstructions(ctx),
    setReviewInstructions: (input) => setReviewInstructions(ctx, input),
    setPinned: (input) => setPinned(ctx, input),
    setViewed: (input) => setViewed(ctx, input),
    addDraftComment: (input) => addDraftComment(ctx, input),
    replyDraft: (input) => replyDraft(ctx, input),
    editDraft: (input) => editDraft(ctx, input),
    deleteDraft: (input) => deleteDraft(ctx, input),
    submitReview: (input) => submitReview(ctx, input),
    discardReview: (input) => discardReview(ctx, input),
    startReview: (input) => startReview(ctx, input),
    fixChecksPrompt: (input) => fixChecksPrompt(ctx, input),
    startFix: (input) => startFix(ctx, input),
    localBranch: (input) => localBranch(ctx, input),
    localBranches: () => localBranches(ctx),
    localChanges: (input) => localChanges(ctx, input),
    sharedComparison: (input) => sharedComparison(ctx, input),
    branchActivity: (input) => branchActivity(ctx, input),
    branchReviewed: (input) => branchReviewed(ctx, input),
    setBranchViewed: (input) => setBranchViewed(ctx, input),
    startLocalReview: (input) => startLocalReview(ctx, input),
    fileBlobs: (input) => fileBlobs(ctx, input),
    unityPreview: (input) => unityPreview(ctx, input),
    prWatches: (input) => prWatches(ctx, input),
    stopPrWatch: (input) => stopPrWatch(ctx, input),
  });
  bb.cli.register(
    defineCli({
      name: "review",
      summary: "CLI for the code-review plugin",
      commands: { playbook: playbook(ctx), prompt: prompt() },
    }),
  );
  bb.agents.registerTool(reportFindings(ctx));
  bb.agents.registerTool(shareChanges(ctx));
  bb.agents.registerTool(watchPr(ctx));
  // Review threads get the findings tool; authors get the watch tool and the skills.
  bb.agents.configure((session) => ({
    tools: [
      ...(reportFindingsEnabled(session) ? ["code_review_report_findings"] : []),
      "code_review_share_changes",
      ...(watchPrEnabled(session) ? ["code_review_watch_pr"] : []),
    ],
    skills: reviewSkills(session),
  }));

  // Previews read whole files from here: images, models, audio, fonts.
  bb.http.route("GET", BLOB_PATH, (context) => serveBlob(blobs, context.req.raw));
  // three.js and its loaders, imported by the app only when a card shows a model or game image.
  bb.http.route("GET", THREE_KIT_PATH, (context) => {
    const headers = { etag: THREE_KIT_ETAG, "cache-control": "no-cache" };
    if (context.req.header("if-none-match") === THREE_KIT_ETAG) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(threeKitSource, {
      headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
    });
  });
  // A review or fix that stops working changes what its pull request or branch shows,
  // and a thread that stops working can hear what its watched pull requests did meanwhile.
  const settled = async ({ thread }: { thread: { id: string } }) => {
    const linked = await store.linkForThread(thread.id);
    if (linked) publishActivity(bb, linked.key);
    await watcher.flush(thread.id);
  };
  bb.events.on("thread.idle", settled);
  bb.events.on("thread.failed", settled);
  const gone = ({ thread }: { thread: { id: string } }) => watcher.forget(thread.id);
  bb.events.on("thread.archived", gone);
  bb.events.on("thread.deleted", gone);
  bb.background.service("pr-watch", { start: (signal) => watcher.run(signal) });
}
