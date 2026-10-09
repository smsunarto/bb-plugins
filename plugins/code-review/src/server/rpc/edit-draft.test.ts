import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { editDraft } from "./edit-draft.ts";

test("rewrites the draft's body", async () => {
  const { ctx, calls } = fakeContext({
    graphql: {
      EditDraft: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: "C1" } } },
    },
  });
  expect(await callProcedure(editDraft, ctx, { commentId: "C1", body: "Rename it." })).toEqual({
    ok: true,
  });
  expect(calls).toEqual([
    { kind: "graphql", operation: "EditDraft", variables: { id: "C1", body: "Rename it." } },
  ]);
});
