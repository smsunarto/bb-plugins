import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { parkedBranches } from "./parked-branches.ts";

test("forwards the repository to the thread's host", async () => {
  const answer = {
    branches: [
      {
        name: "scott/monokai-codex-stream",
        subject: "feat(monokai): stream codex output",
        updatedAt: "2026-09-30T06:03:46.000Z",
      },
    ],
    hasMore: false,
    reason: null,
  };
  const { ctx, calls } = harness({ result: answer });

  expect(await parkedBranches.execute(ctx, { threadId: "t1", repositoryKey: "." })).toEqual(answer);
  expect(calls).toEqual([
    {
      method: "parkedBranches",
      input: { environmentPath: "/work", repositoryKey: "." },
      options: { hostId: "host-1" },
    },
  ]);
});

test("returns no branches with a reason when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });

  expect(await parkedBranches.execute(ctx, { threadId: "t1" })).toEqual({
    branches: [],
    hasMore: false,
    reason: "This thread has no project environment.",
  });
  expect(calls).toEqual([]);
});
