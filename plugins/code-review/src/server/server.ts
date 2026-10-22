import { instructionFiles } from "@bb-kit/core/instructions";
import { definePlugin } from "@bb-kit/core/plugin";
import { playbook } from "./command/playbook.ts";
import { publishActivity } from "./lib/activity.ts";
import { createGitHub } from "./lib/gh.ts";
import { createStore } from "./lib/store.ts";
import { addDraftComment } from "./rpc/add-draft-comment.ts";
import { agentActivity } from "./rpc/agent-activity.ts";
import { branchActivity } from "./rpc/branch-activity.ts";
import { branchReviewed } from "./rpc/branch-reviewed.ts";
import { setBranchViewed } from "./rpc/set-branch-viewed.ts";
import { changedFiles } from "./rpc/changed-files.ts";
import { checks } from "./rpc/checks.ts";
import { deleteDraft } from "./rpc/delete-draft.ts";
import { discardReview } from "./rpc/discard-review.ts";
import { editDraft } from "./rpc/edit-draft.ts";
import { fixChecksPrompt } from "./rpc/fix-checks-prompt.ts";
import { inbox } from "./rpc/inbox.ts";
import { localBranch } from "./rpc/local-branch.ts";
import { localBranches } from "./rpc/local-branches.ts";
import { localChanges } from "./rpc/local-changes.ts";
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
import { submitReview } from "./rpc/submit-review.ts";
import { reportFindings } from "./tools/report-findings.ts";
import { shareChanges } from "./tools/share-changes.ts";

export default definePlugin({
  pluginId: "code-review",
  cliName: "review",
  command: { playbook },
  services(bb) {
    return { github: createGitHub(), store: createStore(bb.storage.kv) };
  },
  rpc: {
    status,
    inbox,
    pullRequest,
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
    branchActivity,
    branchReviewed,
    setBranchViewed,
    startLocalReview,
  },
  agents: {
    files: instructionFiles(import.meta.url),
    tools: { report_findings: reportFindings, share_changes: shareChanges },
  },
  setup({ bb, store }) {
    // A review or fix that stops working changes what its pull request or branch shows.
    const settled = async ({ thread }: { thread: { id: string } }) => {
      const linked = await store.linkForThread(thread.id);
      if (linked) publishActivity(bb, linked.key);
    };
    bb.events.on("thread.idle", settled);
    bb.events.on("thread.failed", settled);
  },
});
