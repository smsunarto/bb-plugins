import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { submitReview, submitReviewContract } from "./submit-review.ts";

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
    await submitReview(ctx, {
      account: "octocat",
      pullRequestId: "PR_1",
      headRefOid: "abc",
      event: "COMMENT",
      body: "A few notes.",
    }),
  ).toEqual({ url: "https://github.com/o/r/pull/1#r" });
  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "SubmitReview",
    account: "octocat",
    variables: { input: { pullRequestReviewId: "PRR_1", event: "COMMENT", body: "A few notes." } },
  });
});

test("rejects an event GitHub does not have", () => {
  expect(
    submitReviewContract.input.safeParse({
      account: "octocat",
      pullRequestId: "PR_1",
      headRefOid: "abc",
      event: "MERGE",
      body: "",
    }).success,
  ).toBe(false);
});
