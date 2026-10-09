import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { addDraftComment } from "./add-draft-comment.ts";

const DRAFT = {
  pullRequestId: "PR_1",
  headRefOid: "abc",
  baseRefName: "main",
  path: "a.ts",
  body: "Rename this.",
  line: 3,
  startLine: null,
  side: "RIGHT",
  startSide: null,
};

/** The thread `DRAFT` started, as GitHub lists it. */
const SAVED_THREAD = {
  id: "T0",
  path: "a.ts",
  line: 3,
  startLine: null,
  diffSide: "RIGHT",
  startDiffSide: null,
  subjectType: "LINE",
  comments: { nodes: [{ id: "C0", body: "Rename this.", pullRequestReview: { id: "PRR_1" } }] },
};

/**
 * GitHub with the viewer's pending review on `head`, which is the pull
 * request's head, and `base` as its base. The review holds one draft.
 * `threads` are the pull request's review threads.
 */
function github(head = "abc", base = "main", threads: unknown[] = []) {
  return fakeContext({
    graphql: {
      PendingReview: {
        node: {
          headRefOid: head,
          baseRefName: base,
          reviews: { nodes: [{ id: "PRR_1", commit: { oid: head }, comments: { totalCount: 1 } }] },
        },
      },
      DraftThreads: {
        node: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads },
        },
      },
      AddDraftThread: {
        addPullRequestReviewThread: { thread: { id: "T1", comments: { nodes: [{ id: "C1" }] } } },
      },
    },
  });
}

test("writes the draft into the viewer's pending review and returns the review", async () => {
  const { ctx, operations } = github();
  expect(await callProcedure(addDraftComment, ctx, DRAFT)).toEqual({
    threadId: "T1",
    commentId: "C1",
    pendingReview: { id: "PRR_1", draftCount: 2 },
  });
  expect(operations()).toEqual(["PendingReview", "DraftThreads", "AddDraftThread"]);
});

test("the first draft returns the pending review it started", async () => {
  const { ctx, operations } = fakeContext({
    graphql: {
      PendingReview: { node: { headRefOid: "abc", baseRefName: "main", reviews: { nodes: [] } } },
      StartReview: { addPullRequestReview: { pullRequestReview: { id: "PRR_9" } } },
      AddDraftThread: {
        addPullRequestReviewThread: { thread: { id: "T1", comments: { nodes: [{ id: "C1" }] } } },
      },
    },
  });
  expect(await callProcedure(addDraftComment, ctx, DRAFT)).toEqual({
    threadId: "T1",
    commentId: "C1",
    pendingReview: { id: "PRR_9", draftCount: 1 },
  });
  expect(operations()).toEqual(["PendingReview", "StartReview", "AddDraftThread"]);
});

test("a draft the pending review already holds is returned, not written again", async () => {
  const { ctx, operations } = github("abc", "main", [SAVED_THREAD]);
  expect(await callProcedure(addDraftComment, ctx, { ...DRAFT, body: "Rename this.\n" })).toEqual({
    threadId: "T0",
    commentId: "C0",
    pendingReview: { id: "PRR_1", draftCount: 1 },
  });
  expect(operations()).toEqual(["PendingReview", "DraftThreads"]);
});

test("a range from base line 40 to head line 12 is written as picked", async () => {
  const { ctx, calls } = github();
  await callProcedure(addDraftComment, ctx, {
    ...DRAFT,
    startLine: 40,
    startSide: "LEFT",
    line: 12,
    side: "RIGHT",
  });
  expect(calls[2]).toEqual({
    kind: "graphql",
    operation: "AddDraftThread",
    variables: {
      input: {
        pullRequestReviewId: "PRR_1",
        path: "a.ts",
        body: "Rename this.",
        line: 12,
        side: "RIGHT",
        startLine: 40,
        startSide: "LEFT",
      },
    },
  });
});

test("a pull request pushed to since the lines were picked gets nothing written", async () => {
  const { ctx, operations } = github("def", "main", [SAVED_THREAD]);
  await expect(callProcedure(addDraftComment, ctx, DRAFT)).rejects.toThrow(
    "This pull request has changed since you picked these lines. Reload the diff and pick them again.",
  );
  expect(operations()).toEqual(["PendingReview"]);
});

test("a pull request retargeted since the lines were picked gets nothing written", async () => {
  const { ctx, operations } = github("abc", "release");
  await expect(callProcedure(addDraftComment, ctx, DRAFT)).rejects.toThrow(
    "This pull request has changed since you picked these lines. Reload the diff and pick them again.",
  );
  expect(operations()).toEqual(["PendingReview"]);
});

test("a draft that does not say which base its lines were picked against is refused", async () => {
  const { ctx, calls } = github();
  const { baseRefName: _baseRefName, ...withoutBase } = DRAFT;
  await expect(callProcedure(addDraftComment, ctx, withoutBase)).rejects.toThrow("invalid input");
  await expect(callProcedure(addDraftComment, ctx, { ...DRAFT, baseRefName: "" })).rejects.toThrow(
    "invalid input",
  );
  expect(calls).toEqual([]);
});

test("refuses an empty comment or a range that ends before it starts", async () => {
  const { ctx, calls } = fakeContext();
  await expect(callProcedure(addDraftComment, ctx, { ...DRAFT, body: " \n" })).rejects.toThrow(
    "Write a comment first.",
  );
  await expect(
    callProcedure(addDraftComment, ctx, {
      ...DRAFT,
      startLine: 40,
      startSide: "RIGHT",
      line: 12,
      side: "RIGHT",
    }),
  ).rejects.toThrow("A comment's range must start at or before its last line.");
  expect(calls).toEqual([]);
});
