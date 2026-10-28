import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { discardReview } from "./discard-review.ts";

test("deletes the pending review with its drafts", async () => {
  const { ctx, operations } = fakeContext({
    graphql: {
      PendingReview: {
        node: { reviews: { nodes: [{ id: "PRR_1", comments: { totalCount: 4 } }] } },
      },
      DiscardReview: { deletePullRequestReview: { clientMutationId: null } },
    },
  });
  expect(await discardReview(ctx, { account: "octocat", pullRequestId: "PR_1" })).toEqual({
    ok: true,
  });
  expect(operations()).toEqual(["PendingReview", "DiscardReview"]);
});
