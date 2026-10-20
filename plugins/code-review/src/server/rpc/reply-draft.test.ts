import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { replyDraft } from "./reply-draft.ts";

test("writes a draft reply into the pending review", async () => {
  const { ctx, calls } = fakeContext({
    graphql: {
      PendingReview: {
        node: { reviews: { nodes: [{ id: "PRR_1", comments: { totalCount: 0 } }] } },
      },
      ReplyDraft: { addPullRequestReviewThreadReply: { comment: { id: "C2" } } },
    },
  });
  expect(
    await callProcedure(replyDraft, ctx, {
      account: "octocat",
      pullRequestId: "PR_1",
      threadId: "T1",
      body: "Done.",
    }),
  ).toEqual({ commentId: "C2", pendingReview: { id: "PRR_1", draftCount: 1 } });
  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "ReplyDraft",
    account: "octocat",
    variables: {
      input: { pullRequestReviewId: "PRR_1", pullRequestReviewThreadId: "T1", body: "Done." },
    },
  });
});
