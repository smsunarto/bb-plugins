import { instructionFiles } from "@bb-kit/core/instructions";
import { definePlugin } from "@bb-kit/core/plugin";
import { playbook } from "./command/playbook.ts";
import { prompt } from "./command/prompt.ts";
import threeKitSource, { THREE_KIT_ETAG } from "../../vendor/three-kit.ts";
import { BLOB_PATH, THREE_KIT_PATH } from "../shared/blob-url.ts";
import { publishActivity } from "./lib/activity.ts";
import { serveBlob } from "./lib/blob-route.ts";
import { createBlobReader } from "./lib/blobs.ts";
import { createGitHub } from "./lib/gh.ts";
import { createPrWatcher } from "./lib/pr-watch.ts";
import { createStore } from "./lib/store.ts";
import { reviewSkills } from "./lib/review-scope.ts";
import { createUnityPreviews } from "./lib/unity-preview.ts";
import { addDraftComment } from "./rpc/add-draft-comment.ts";
import { agentActivity } from "./rpc/agent-activity.ts";
import { branchActivity } from "./rpc/branch-activity.ts";
import { branchReviewed } from "./rpc/branch-reviewed.ts";
import { setBranchViewed } from "./rpc/set-branch-viewed.ts";
import { changedFiles } from "./rpc/changed-files.ts";
import { checks } from "./rpc/checks.ts";
import { fileBlobs } from "./rpc/file-blobs.ts";
import { deleteDraft } from "./rpc/delete-draft.ts";
import { discardReview } from "./rpc/discard-review.ts";
import { editDraft } from "./rpc/edit-draft.ts";
import { fixChecksPrompt } from "./rpc/fix-checks-prompt.ts";
import { inbox } from "./rpc/inbox.ts";
import { localBranch } from "./rpc/local-branch.ts";
import { localBranches } from "./rpc/local-branches.ts";
import { localChanges } from "./rpc/local-changes.ts";
import { sharedComparison } from "./rpc/shared-comparison.ts";
import { prWatches } from "./rpc/pr-watches.ts";
import { prActionState } from "./rpc/pr-action-state.ts";
import { prAction } from "./rpc/pr-action.ts";
import { pullRequest } from "./rpc/pull-request.ts";
import { replyDraft } from "./rpc/reply-draft.ts";
import { reviewInstructions } from "./rpc/review-instructions.ts";
import { setPinned } from "./rpc/set-pinned.ts";
import { setReviewInstructions } from "./rpc/set-review-instructions.ts";
import { setViewed } from "./rpc/set-viewed.ts";
import { startFix } from "./rpc/start-fix.ts";
import { startLocalReview } from "./rpc/start-local-review.ts";
import { startReview } from "./rpc/start-review.ts";
import { status } from "./rpc/status.ts";
import { stopPrWatch } from "./rpc/stop-pr-watch.ts";
import { submitReview } from "./rpc/submit-review.ts";
import { unityPreview } from "./rpc/unity-preview.ts";
import { reportFindings } from "./tools/report-findings.ts";
import { shareChanges } from "./tools/share-changes.ts";
import { watchPr } from "./tools/watch-pr.ts";

export default definePlugin({
  pluginId: "code-review",
  cliName: "review",
  command: { playbook, prompt },
  services(bb) {
    const github = createGitHub();
    const blobs = createBlobReader({ bb, github });
    return {
      github,
      store: createStore(bb.storage.kv),
      blobs,
      unity: createUnityPreviews(blobs),
      watcher: createPrWatcher({ bb, github }),
    };
  },
  rpc: {
    status,
    inbox,
    pullRequest,
    prAction,
    prActionState,
    changedFiles,
    checks,
    agentActivity,
    reviewInstructions,
    setReviewInstructions,
    setPinned,
    setViewed,
    addDraftComment,
    replyDraft,
    editDraft,
    deleteDraft,
    submitReview,
    discardReview,
    startReview,
    fixChecksPrompt,
    startFix,
    localBranch,
    localBranches,
    localChanges,
    sharedComparison,
    branchActivity,
    branchReviewed,
    setBranchViewed,
    startLocalReview,
    fileBlobs,
    unityPreview,
    prWatches,
    stopPrWatch,
  },
  agents: {
    files: instructionFiles(import.meta.url),
    skills: reviewSkills,
    tools: { report_findings: reportFindings, share_changes: shareChanges, watch_pr: watchPr },
  },
  setup({ bb, store, blobs, watcher }) {
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
  },
});
