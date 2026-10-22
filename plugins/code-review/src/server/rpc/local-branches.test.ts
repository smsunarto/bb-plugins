import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { UNPUBLISHED, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import type { LocalBranches } from "../../shared/schema.ts";
import { localBranches } from "./local-branches.ts";

test("the branch list is the GitButler plugin's, by id", async () => {
  const { ctx } = fakeContext(
    {},
    { plugins: fakeGitButler({ unpublishedBranches: () => UNPUBLISHED }) },
  );

  const read = (await callProcedure(localBranches, ctx, {})) as LocalBranches;

  expect(read.available && read.branches.map((branch) => [branch.id, branch.branch])).toEqual([
    ["f4b6d5b36a16", "scott/rate-limit"],
    ["012abaff5bd7", "scott/login-copy"],
    ["bddb4c3d89da", "fix-nav"],
  ]);
});

test("without the GitButler plugin the list says so", async () => {
  const { ctx } = fakeContext({}, { plugins: fakeGitButler({}, { installed: false }) });

  expect(await callProcedure(localBranches, ctx, {})).toEqual({
    available: false,
    reason:
      "Install and enable the GitButler plugin to review branches that have no pull request yet.",
  });
});

test("a locator cache write failure does not hide the branch list", async () => {
  const { ctx } = fakeContext(
    {},
    { plugins: fakeGitButler({ unpublishedBranches: () => UNPUBLISHED }) },
  );
  ctx.store.rememberBranch = async () => {
    throw new Error("storage unavailable");
  };
  const read = (await callProcedure(localBranches, ctx, {})) as LocalBranches;
  expect(read.available && read.branches.length).toBe(3);
});
