import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { submitReview } from "./submit-review.ts";

test("submits the pending review and answers its URL", async () => {
  const { ctx, calls } = fakeContext({
    graphql: {
      PendingReview: {
        node: { reviews: { nodes: [{ id: "PRR_1", comments: { totalCount: 2 } }] } },
      },
      SubmitReview: {
        submitPullRequestReview: { pullRequestReview: { url: "https://github.com/o/r/pull/1#r" } },
      },
    },
  });
  expect(
    await callProcedure(submitReview, ctx, {
      pullRequestId: "PR_1",
      headRefOid: "abc",
      event: "COMMENT",
      body: "A few notes.",
    }),
  ).toEqual({ url: "https://github.com/o/r/pull/1#r" });
  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "SubmitReview",
    variables: { input: { pullRequestReviewId: "PRR_1", event: "COMMENT", body: "A few notes." } },
  });
});

test("rejects an event GitHub does not have", async () => {
  const { ctx } = fakeContext();
  await expect(
    callProcedure(submitReview, ctx, {
      pullRequestId: "PR_1",
      headRefOid: "abc",
      event: "MERGE",
      body: "",
    }),
  ).rejects.toThrow("invalid input");
});
