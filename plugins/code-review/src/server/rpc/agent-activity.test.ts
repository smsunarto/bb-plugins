import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { agentActivity } from "./agent-activity.ts";

test("lists the threads started for the pull request with their live status", async () => {
  const { ctx } = fakeContext(
    {},
    {
      threads: {
        get: async ({ threadId }) => ({
          id: threadId,
          title: "Review cli/cli#9000",
          titleFallback: null,
          status: "active",
          deletedAt: null,
        }),
      },
    },
  );
  const ref = { owner: "cli", repo: "cli", number: 9000 };
  await ctx.store.addLink("cli/cli#9000", {
    threadId: "t1",
    kind: "review",
    createdAt: "2026-10-01T00:00:00.000Z",
    headRefOid: "abc",
    baseRefName: "main",
  });

  expect(await agentActivity(ctx, { ref })).toEqual({
    threads: [
      {
        threadId: "t1",
        kind: "review",
        title: "Review cli/cli#9000",
        status: "active",
        createdAt: "2026-10-01T00:00:00.000Z",
        headRefOid: "abc",
        baseRefName: "main",
      },
    ],
    latestReview: null,
  });
});
