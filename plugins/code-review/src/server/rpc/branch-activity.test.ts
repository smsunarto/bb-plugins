import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { branchActivity, branchActivityContract } from "./branch-activity.ts";

test("a branch's activity is the threads linked to it, read live", async () => {
  const { ctx } = fakeContext(
    {},
    {
      threads: {
        get: async ({ threadId }) => ({
          id: threadId,
          title: "Review scott/rate-limit",
          titleFallback: null,
          status: "idle",
          deletedAt: null,
        }),
      },
    },
  );
  const link = {
    threadId: "t1",
    kind: "review" as const,
    createdAt: "2026-10-10T00:00:00.000Z",
    headRefOid: "cc36d32",
    baseRefName: "4b825dc",
  };
  await ctx.store.addLink("branch:f4b6d5b36a16", link);
  await ctx.store.addLink("acme/api#1", { ...link, threadId: "t2" });

  expect(await branchActivity(ctx, { id: "f4b6d5b36a16" })).toEqual({
    threads: [
      {
        threadId: "t1",
        kind: "review",
        title: "Review scott/rate-limit",
        status: "idle",
        createdAt: "2026-10-10T00:00:00.000Z",
        headRefOid: "cc36d32",
        baseRefName: "4b825dc",
      },
    ],
    latestReview: null,
  });
  expect(branchActivityContract.input.safeParse({ id: "../x" }).success).toBe(false);
});
