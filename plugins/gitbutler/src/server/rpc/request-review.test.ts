import { expect, test } from "bun:test";
import { reviewContext as context } from "../../../test/review-stub.ts";
import { requestReview } from "./request-review.ts";

test("spawns a visible child on the same environment, pointed at the repository path", async () => {
  const { ctx, spawned } = context();

  expect(await requestReview.execute(ctx, { threadId: "t1", branch: "scott/top" })).toEqual({
    threadId: "child-1",
  });
  expect(spawned[0]).toMatchObject({
    projectId: "p1",
    environment: { type: "reuse", environmentId: "env-1" },
    providerId: "claude-code",
    parentThreadId: "t1",
    title: "Create PR for scott/top",
  });
  // No key means the panel's default repository, and the child gets its path.
  expect(spawned[0]!["prompt"]).toContain("cd '/work/repos/api'\nbut show 'scott/top'");
});

test("asking again while the child works returns it instead of spawning another", async () => {
  const { ctx, spawned } = context();
  await requestReview.execute(ctx, { threadId: "t1", branch: "scott/top" });

  expect(await requestReview.execute(ctx, { threadId: "t1", branch: "scott/top" })).toEqual({
    threadId: "child-1",
  });
  expect(spawned).toHaveLength(1);
  // The same branch name in another repository is another PR.
  await requestReview.execute(ctx, { threadId: "t1", repositoryKey: ".", branch: "scott/top" });
  expect(spawned).toHaveLength(2);
});

test("spawns nothing for a thread without an environment", async () => {
  const { ctx, spawned, hostInputs } = context({ environment: null });
  await expect(requestReview.execute(ctx, { threadId: "t1", branch: "b" })).rejects.toThrow(
    "This thread has no project environment.",
  );
  expect(spawned).toHaveLength(0);
  expect(hostInputs).toHaveLength(0);
});
