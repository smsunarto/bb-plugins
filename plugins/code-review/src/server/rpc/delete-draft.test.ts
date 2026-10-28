import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { deleteDraft } from "./delete-draft.ts";

test("deletes the draft", async () => {
  const { ctx, calls } = fakeContext({
    graphql: { DeleteDraft: { deletePullRequestReviewComment: { clientMutationId: null } } },
  });
  expect(await deleteDraft(ctx, { account: "octocat", commentId: "C1" })).toEqual({
    ok: true,
  });
  expect(calls).toEqual([
    { kind: "graphql", operation: "DeleteDraft", variables: { id: "C1" }, account: "octocat" },
  ]);
});
