import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { reviewUrl } from "./review-url.ts";

test("forwards the branch to the thread's host", async () => {
  const url = "https://github.com/get-bb/bb/pull/4605";
  const { ctx, calls } = harness({ result: { url } });

  expect(
    await reviewUrl.execute(ctx, {
      threadId: "t1",
      repositoryKey: "repos/api",
      branch: "scott/top",
    }),
  ).toEqual({ url });
  expect(calls).toEqual([
    {
      method: "reviewUrl",
      input: { environmentPath: "/work", repositoryKey: "repos/api", branch: "scott/top" },
      options: { hostId: "host-1" },
    },
  ]);
});

test("fails loudly when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });

  await expect(reviewUrl.execute(ctx, { threadId: "t1", branch: "scott/top" })).rejects.toThrow(
    "This thread has no project environment.",
  );
  expect(calls).toEqual([]);
});
