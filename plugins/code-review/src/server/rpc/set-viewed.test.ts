import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { setViewed } from "./set-viewed.ts";

test("marks the file on GitHub and answers its new state", async () => {
  const { ctx, operations } = fakeContext({
    graphql: { MarkViewed: { markFileAsViewed: { clientMutationId: null } } },
  });
  expect(
    await setViewed(ctx, {
      account: "octocat",
      pullRequestId: "PR_1",
      path: "a.ts",
      viewed: true,
    }),
  ).toEqual({ viewed: "viewed" });
  expect(operations()).toEqual(["MarkViewed"]);
});
