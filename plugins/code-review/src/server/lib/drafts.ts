import type { DiffRevision, DiffSide, ReviewEvent } from "../../shared/schema.ts";
import type { Gh } from "./gh.ts";
import { GhError } from "./gh.ts";
import type { GqlPageInfo } from "./github.ts";
import { createLocks } from "./lock.ts";

/*
 * Draft comments are comments on the viewer's PENDING review on GitHub.
 * GitHub allows one pending review per person per pull request: the first
 * draft starts it, later drafts join it, and submitting it posts them all at
 * once. Nothing here is visible to anyone else until then.
 */

export const PENDING_REVIEW_QUERY = `query PendingReview($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      headRefOid
      baseRefName
      reviews(states: [PENDING], first: 1) { nodes { id commit { oid } comments { totalCount } } }
    }
  }
}`;

/*
 * Every review thread on the pull request, with only what tells a draft
 * apart: where it sits and the comment that started it. GitHub lists a
 * review's comments but not their threads or sides, so drafts are found
 * among the pull request's threads.
 */
export const DRAFT_THREADS_QUERY = `query DraftThreads($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line startLine diffSide startDiffSide subjectType
          comments(first: 1) { nodes { id body pullRequestReview { id } } }
        }
      }
    }
  }
}`;

export const START_REVIEW_MUTATION = `mutation StartReview($pullRequestId: ID!, $commitOID: GitObjectID) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) {
    pullRequestReview { id }
  }
}`;

export const ADD_THREAD_MUTATION = `mutation AddDraftThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id comments(first: 1) { nodes { id } } } }
}`;

export const REPLY_MUTATION = `mutation ReplyDraft($input: AddPullRequestReviewThreadReplyInput!) {
  addPullRequestReviewThreadReply(input: $input) { comment { id } }
}`;

export const EDIT_MUTATION = `mutation EditDraft($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) {
    pullRequestReviewComment { id }
  }
}`;

export const DELETE_MUTATION = `mutation DeleteDraft($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) { clientMutationId }
}`;

export const SUBMIT_MUTATION = `mutation SubmitReview($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) { pullRequestReview { url } }
}`;

export const ADD_REVIEW_MUTATION = `mutation AddReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { url } }
}`;

export const DISCARD_MUTATION = `mutation DiscardReview($id: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $id }) { clientMutationId }
}`;

export const MARK_VIEWED_MUTATION = `mutation MarkViewed($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

export const UNMARK_VIEWED_MUTATION = `mutation UnmarkViewed($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

/** `commitOid` is the commit its new threads' line numbers are read in. */
type PendingReview = { id: string; draftCount: number; commitOid: string | null };

/** The pull request's head and base, and the viewer's pending review if they have one. */
async function loadPending(
  gh: Gh,
  pullRequestId: string,
): Promise<{
  headRefOid: string | null;
  baseRefName: string | null;
  pending: PendingReview | null;
}> {
  const data = (await gh.graphql(PENDING_REVIEW_QUERY, { id: pullRequestId })) as {
    node: {
      headRefOid?: string;
      baseRefName?: string;
      reviews?: {
        nodes: { id: string; commit: { oid: string } | null; comments: { totalCount: number } }[];
      };
    } | null;
  };
  if (!data.node?.reviews) throw new GhError("not-found", "That pull request no longer exists.");
  const review = data.node.reviews.nodes[0];
  return {
    headRefOid: data.node.headRefOid ?? null,
    baseRefName: data.node.baseRefName ?? null,
    pending: review
      ? {
          id: review.id,
          draftCount: review.comments.totalCount,
          commitOid: review.commit?.oid ?? null,
        }
      : null,
  };
}

/*
 * Two drafts written at once would each find no pending review and each try
 * to start one, and GitHub rejects the second. Writes to one pull request
 * run one after another.
 */
const serialize = createLocks();

/** `commitOID` pins the review to the commit the reader saw; null lets GitHub use the head. */
async function startReview(gh: Gh, pullRequestId: string, commitOID: string | null) {
  const data = (await gh.graphql(START_REVIEW_MUTATION, { pullRequestId, commitOID })) as {
    addPullRequestReview: { pullRequestReview: { id: string } | null };
  };
  const review = data.addPullRequestReview.pullRequestReview;
  if (!review) throw new GhError("failed", "GitHub did not start a review.");
  return review.id;
}

export type DraftComment = DiffRevision & {
  pullRequestId: string;
  path: string;
  body: string;
  line: number;
  startLine: number | null;
  side: DiffSide;
  startSide: DiffSide | null;
};

export const LINES_MOVED =
  "This pull request has changed since you picked these lines. Reload the diff and pick them again.";

export const REVIEW_BEHIND =
  "Your pending review is on an older commit, so a new comment would land on the wrong lines. Submit or discard your drafts, then comment again.";

/** The draft's thread and first comment, and the pending review that now holds it. */
export type SavedDraft = {
  threadId: string;
  commentId: string;
  pendingReview: { id: string; draftCount: number };
};

type Lines = {
  line: number | null;
  side: DiffSide;
  startLine: number | null;
  startSide: DiffSide | null;
};

/**
 * Where a range starts, or null for one line. A range can start on the base
 * and end on the head, so LEFT 10 to RIGHT 10 is two lines.
 */
function rangeStart(lines: Lines) {
  const startSide = lines.startSide ?? lines.side;
  return lines.startLine !== null && (lines.startLine !== lines.line || startSide !== lines.side)
    ? { startLine: lines.startLine, startSide }
    : null;
}

/**
 * Where a thread sits, as a key two threads on the same lines share. A
 * file-level thread sits on its file alone.
 */
function spot(path: string, subjectType: string, lines: Lines): string {
  if (subjectType === "FILE") return JSON.stringify([path, subjectType]);
  return JSON.stringify([path, subjectType, lines.line, lines.side, rangeStart(lines)]);
}

type DraftThread = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: DiffSide;
  /** GitHub often leaves this null, on ranges too, so null reads as `diffSide`. */
  startDiffSide: DiffSide | null;
  subjectType: string;
  comments: { nodes: { id: string; body: string; pullRequestReview: { id: string } | null }[] };
};

/**
 * Pages of 100 threads read while looking for a repeated draft. A pull
 * request with more threads than this has its draft refused, not written,
 * because a scan that stops early cannot tell "not saved" from "not seen".
 */
const MAX_THREAD_PAGES = 30;

/**
 * The thread in pending review `reviewId` that `draft` repeats: started on
 * the same lines with the same text. Only a thread's first comment is read,
 * so a reply never counts.
 */
async function findDraft(gh: Gh, reviewId: string, draft: DraftComment) {
  const body = draft.body.trim();
  const where = spot(draft.path, "LINE", draft);
  const repeats = (thread: DraftThread) => {
    const first = thread.comments.nodes[0];
    if (first?.pullRequestReview?.id !== reviewId || first.body.trim() !== body) return false;
    const lines = {
      line: thread.line,
      side: thread.diffSide,
      startLine: thread.startLine,
      startSide: thread.startDiffSide,
    };
    return spot(thread.path, thread.subjectType, lines) === where;
  };
  let after: string | null = null;
  for (let fetched = 0; fetched < MAX_THREAD_PAGES; fetched++) {
    const data = (await gh.graphql(DRAFT_THREADS_QUERY, { id: draft.pullRequestId, after })) as {
      node: { reviewThreads: { pageInfo: GqlPageInfo; nodes: DraftThread[] } };
    };
    const { pageInfo, nodes } = data.node.reviewThreads;
    const thread = nodes.find(repeats);
    const first = thread?.comments.nodes[0];
    if (thread && first) return { threadId: thread.id, commentId: first.id };
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) return null;
    after = pageInfo.endCursor;
  }
  throw new GhError(
    "failed",
    "This pull request has too many review threads to check that this draft is not already saved. Comment on GitHub instead.",
  );
}

/**
 * Writes a new draft thread on a line or a range of lines. Line numbers
 * count lines in one diff, and GitHub anchors a new thread to its pending
 * review's commit. So the draft is written only when the head and base the
 * reader picked lines in are still the pull request's, and that head is the
 * pending review's commit. Otherwise nothing is written.
 *
 * A draft the pending review already holds is not written again: a retry,
 * a remount, or a second window can send the same one twice. The lock makes
 * that check and the write one step.
 */
export function addDraftComment(gh: Gh, draft: DraftComment): Promise<SavedDraft> {
  return serialize(draft.pullRequestId, async () => {
    const { headRefOid, baseRefName, pending } = await loadPending(gh, draft.pullRequestId);
    // A retarget moves the base side's lines without a new head.
    if (headRefOid !== draft.headRefOid || baseRefName !== draft.baseRefName) {
      throw new Error(LINES_MOVED);
    }
    if (pending && pending.commitOid !== draft.headRefOid) throw new Error(REVIEW_BEHIND);
    // An empty pending review holds nothing to repeat, so it skips the read.
    if (pending?.draftCount) {
      const saved = await findDraft(gh, pending.id, draft);
      const pendingReview = { id: pending.id, draftCount: pending.draftCount };
      if (saved) return { ...saved, pendingReview };
    }
    const reviewId = pending?.id ?? (await startReview(gh, draft.pullRequestId, draft.headRefOid));
    const data = (await gh.graphql(ADD_THREAD_MUTATION, {
      input: {
        pullRequestReviewId: reviewId,
        path: draft.path,
        body: draft.body,
        line: draft.line,
        side: draft.side,
        ...rangeStart(draft),
      },
    })) as {
      addPullRequestReviewThread: {
        thread: { id: string; comments: { nodes: { id: string }[] } } | null;
      };
    };
    const thread = data.addPullRequestReviewThread.thread;
    const comment = thread?.comments.nodes[0];
    if (!thread || !comment) {
      throw new GhError("failed", "GitHub did not save the comment. Is that line in the diff?");
    }
    return {
      threadId: thread.id,
      commentId: comment.id,
      pendingReview: { id: reviewId, draftCount: (pending?.draftCount ?? 0) + 1 },
    };
  });
}

/** Writes a draft reply to an existing thread. */
export function replyDraft(
  gh: Gh,
  reply: { pullRequestId: string; threadId: string; body: string },
) {
  return serialize(reply.pullRequestId, async () => {
    const { pending } = await loadPending(gh, reply.pullRequestId);
    const reviewId = pending?.id ?? (await startReview(gh, reply.pullRequestId, null));
    const data = (await gh.graphql(REPLY_MUTATION, {
      input: {
        pullRequestReviewId: reviewId,
        pullRequestReviewThreadId: reply.threadId,
        body: reply.body,
      },
    })) as { addPullRequestReviewThreadReply: { comment: { id: string } | null } };
    const comment = data.addPullRequestReviewThreadReply.comment;
    if (!comment) throw new GhError("failed", "GitHub did not save the reply.");
    return {
      commentId: comment.id,
      pendingReview: { id: reviewId, draftCount: (pending?.draftCount ?? 0) + 1 },
    };
  });
}

export async function editDraft(gh: Gh, commentId: string, body: string): Promise<void> {
  await gh.graphql(EDIT_MUTATION, { id: commentId, body });
}

export async function deleteDraft(gh: Gh, commentId: string): Promise<void> {
  await gh.graphql(DELETE_MUTATION, { id: commentId });
}

/**
 * Submits the pending review with every draft in it, or, with no drafts,
 * posts a review of the body alone. GitHub refuses a comment or a request
 * for changes that says nothing, so that is refused here with a reason.
 */
export function submitReview(
  gh: Gh,
  review: { pullRequestId: string; headRefOid: string; event: ReviewEvent; body: string },
) {
  return serialize(review.pullRequestId, async () => {
    const { pending } = await loadPending(gh, review.pullRequestId);
    const body = review.body.trim();
    if (review.event !== "APPROVE" && body === "" && !pending?.draftCount) {
      throw new Error(
        review.event === "REQUEST_CHANGES"
          ? "Say what needs to change: write a comment or add a draft before requesting changes."
          : "Write a comment or add a draft before submitting.",
      );
    }
    if (pending) {
      const data = (await gh.graphql(SUBMIT_MUTATION, {
        input: { pullRequestReviewId: pending.id, event: review.event, body },
      })) as { submitPullRequestReview: { pullRequestReview: { url: string } | null } };
      return { url: data.submitPullRequestReview.pullRequestReview?.url ?? null };
    }
    const data = (await gh.graphql(ADD_REVIEW_MUTATION, {
      input: {
        pullRequestId: review.pullRequestId,
        commitOID: review.headRefOid,
        event: review.event,
        body,
      },
    })) as { addPullRequestReview: { pullRequestReview: { url: string } | null } };
    return { url: data.addPullRequestReview.pullRequestReview?.url ?? null };
  });
}

/** Deletes the pending review and every draft in it. A no-op without one. */
export function discardReview(gh: Gh, pullRequestId: string) {
  return serialize(pullRequestId, async () => {
    const { pending } = await loadPending(gh, pullRequestId);
    if (pending) await gh.graphql(DISCARD_MUTATION, { id: pending.id });
  });
}

export async function setViewed(
  gh: Gh,
  { pullRequestId, path, viewed }: { pullRequestId: string; path: string; viewed: boolean },
) {
  await gh.graphql(viewed ? MARK_VIEWED_MUTATION : UNMARK_VIEWED_MUTATION, {
    pullRequestId,
    path,
  });
  return viewed ? ("viewed" as const) : ("unviewed" as const);
}
