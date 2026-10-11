import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { deleteDraft } from "./delete-draft.ts";

test("deletes the draft", async () => {
  const { ctx, calls } = fakeContext({
    graphql: { DeleteDraft: { deletePullRequestReviewComment: { clientMutationId: null } } },
  });
  expect(await callProcedure(deleteDraft, ctx, { account: "octocat", commentId: "C1" })).toEqual({
    ok: true,
  });
  expect(calls).toEqual([
    { kind: "graphql", operation: "DeleteDraft", variables: { id: "C1" }, account: "octocat" },
  ]);
});
