import { expect, test } from "bun:test";
import { reviewContext as context } from "../../../test/review-stub.ts";
import { requestReview } from "./request-review.ts";
import { reviewRequests } from "./review-requests.ts";

test("lists the children per repository, drops archived ones, and lets a stopped one retry", async () => {
  const { ctx, spawned, children } = context();
  await requestReview.execute(ctx, { threadId: "t1", branch: "scott/top" });
  await requestReview.execute(ctx, { threadId: "t1", branch: "scott/bottom" });
  await requestReview.execute(ctx, { threadId: "t1", repositoryKey: ".", branch: "elsewhere" });
  children.set("child-1", { status: "idle", archivedAt: null });
  children.set("child-2", { status: "active", archivedAt: 1 });

  expect(await reviewRequests.execute(ctx, { threadId: "t1" })).toEqual({
    requests: [{ branch: "scott/top", threadId: "child-1", running: false }],
  });

  await requestReview.execute(ctx, { threadId: "t1", branch: "scott/top" });
  expect(spawned).toHaveLength(4);
  expect(await reviewRequests.execute(ctx, { threadId: "t1" })).toEqual({
    requests: [{ branch: "scott/top", threadId: "child-4", running: true }],
  });
});
