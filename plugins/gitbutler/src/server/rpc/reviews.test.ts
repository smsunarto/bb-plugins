import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import type { Reviews } from "../../shared/schema.ts";
import { reviews } from "./reviews.ts";

test("forwards the repository to the thread's host", async () => {
  const answer: Reviews = {
    reviews: [
      {
        branch: "scott/top",
        number: 4605,
        state: "open",
        url: "https://github.com/get-bb/bb/pull/4605",
      },
    ],
    reason: null,
  };
  const { ctx, calls } = harness({ result: answer });

  expect(await reviews.execute(ctx, { threadId: "t1", repositoryKey: "repos/api" })).toEqual(
    answer,
  );
  expect(calls).toEqual([
    {
      method: "reviews",
      input: { environmentPath: "/work", repositoryKey: "repos/api" },
      options: { hostId: "host-1" },
    },
  ]);
});

test("returns no reviews with a reason when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });

  expect(await reviews.execute(ctx, { threadId: "t1" })).toEqual({
    reviews: [],
    reason: "This thread has no project environment.",
  });
  expect(calls).toEqual([]);
});
