import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { reviewContext as context } from "../../../test/review-stub.ts";
import { requestReview } from "./request-review.ts";
import { reviewRequests } from "./review-requests.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("spawns a visible child on the same environment, pointed at the repository path", async () => {
  const { ctx, spawned } = context();

  expect(await requestReview(ctx, { threadId: "t1", branch: "scott/top" })).toEqual({
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
  await requestReview(ctx, { threadId: "t1", branch: "scott/top" });

  expect(await requestReview(ctx, { threadId: "t1", branch: "scott/top" })).toEqual({
    threadId: "child-1",
  });
  expect(spawned).toHaveLength(1);
  // The same branch name in another repository is another PR.
  await requestReview(ctx, { threadId: "t1", repositoryKey: ".", branch: "scott/top" });
  expect(spawned).toHaveLength(2);
});

test("PR status remains readable without another full workspace read", async () => {
  const { ctx, hostMethods } = context();
  await requestReview(ctx, { threadId: "t1", branch: "scott/top" });
  hostMethods.length = 0;

  expect(await reviewRequests(ctx, { threadId: "t1" })).toEqual({
    requests: [{ branch: "scott/top", threadId: "child-1", running: true }],
  });
  expect(hostMethods).toEqual(["checkoutIdentity"]);
});

test("overlapping requests for the same branch return one PR subthread", async () => {
  const { ctx, spawned } = context();

  expect(
    await Promise.all([
      requestReview(ctx, { threadId: "t1", branch: "scott/top" }),
      requestReview(ctx, { threadId: "t1", branch: "scott/top" }),
    ]),
  ).toEqual([{ threadId: "child-1" }, { threadId: "child-1" }]);
  expect(spawned.map((child) => child["title"])).toEqual(["Create PR for scott/top"]);
});

test("overlapping requests preserve every branch and repository's PR subthread", async () => {
  const { ctx } = context();
  await Promise.all([
    requestReview(ctx, { threadId: "t1", branch: "scott/top" }),
    requestReview(ctx, { threadId: "t1", branch: "scott/bottom" }),
    requestReview(ctx, { threadId: "t1", repositoryKey: ".", branch: "scott/top" }),
  ]);

  expect(await reviewRequests(ctx, { threadId: "t1" })).toEqual({
    requests: [
      { branch: "scott/top", threadId: "child-1", running: true },
      { branch: "scott/bottom", threadId: "child-3", running: true },
    ],
  });
  expect(await reviewRequests(ctx, { threadId: "t1", repositoryKey: "." })).toEqual({
    requests: [{ branch: "scott/top", threadId: "child-2", running: true }],
  });
});

test("a failed child lookup releases queued requests and later retries", async () => {
  const { ctx } = context();
  await requestReview(ctx, { threadId: "t1", branch: "scott/top" });
  const bb = (ctx as { bb: BbPluginApi }).bb;
  const get = bb.sdk.threads.get.bind(bb.sdk.threads);
  let fail = true;
  bb.sdk.threads.get = async (input) => {
    if (input.threadId === "child-1" && fail) {
      fail = false;
      throw new Error("The child lookup failed.");
    }
    return get(input);
  };

  const failed = requestReview(ctx, { threadId: "t1", branch: "scott/top" });
  const retried = requestReview(ctx, { threadId: "t1", branch: "scott/top" });
  await expect(failed).rejects.toThrow("The child lookup failed.");
  expect(await retried).toEqual({ threadId: "child-1" });
  expect(await requestReview(ctx, { threadId: "t1", branch: "scott/top" })).toEqual({
    threadId: "child-1",
  });
});

test("a request queued before an environment move cannot reuse the old PR subthread", async () => {
  const located = deferred();
  let locations = 0;
  const { ctx, spawned, move } = context({
    onLocate: () => {
      if (++locations === 2) located.resolve();
    },
  });
  const bb = (ctx as { bb: BbPluginApi }).bb;
  const set = bb.storage.kv.set.bind(bb.storage.kv);
  const recording = deferred();
  const release = deferred();
  bb.storage.kv.set = async (...args) => {
    const result = await set(...args);
    recording.resolve();
    await release.promise;
    return result;
  };

  const first = requestReview(ctx, {
    threadId: "t1",
    environmentId: "env-1",
    branch: "scott/top",
  });
  await recording.promise;
  const queued = requestReview(ctx, {
    threadId: "t1",
    environmentId: "env-1",
    branch: "scott/top",
  });
  await located.promise;
  move();
  release.resolve();

  expect(await first).toEqual({ threadId: "child-1" });
  await expect(queued).rejects.toThrow(
    "This thread moved to another environment since the board was read.",
  );
  expect(spawned.map((child) => child["title"])).toEqual(["Create PR for scott/top"]);
});

test("spawns nothing for a thread without an environment", async () => {
  const { ctx, spawned, hostInputs } = context({ environment: null });
  await expect(requestReview(ctx, { threadId: "t1", branch: "b" })).rejects.toThrow(
    "This thread has no project environment.",
  );
  expect(spawned).toHaveLength(0);
  expect(hostInputs).toHaveLength(0);
});

test("spawns nothing for a board read in another environment", async () => {
  const { ctx, spawned } = context();
  await expect(
    requestReview(ctx, { threadId: "t1", environmentId: "env-old", branch: "scott/top" }),
  ).rejects.toThrow("This thread moved to another environment since the board was read.");
  expect(spawned).toHaveLength(0);
  await requestReview(ctx, { threadId: "t1", environmentId: "env-1", branch: "scott/top" });
  expect(spawned).toHaveLength(1);
});

test("spawns nothing when the thread moves while the request runs", async () => {
  let move = () => {};
  const stub = context({ onLocate: () => move() });
  move = stub.move;
  await expect(
    requestReview(stub.ctx, {
      threadId: "t1",
      environmentId: "env-1",
      branch: "scott/top",
    }),
  ).rejects.toThrow("This thread moved to another environment since the board was read.");
  expect(stub.spawned).toHaveLength(0);
});

test("a thread that moved gets a new PR subthread, not the one from its old environment", async () => {
  const { ctx, spawned, move } = context();
  await requestReview(ctx, { threadId: "t1", environmentId: "env-1", branch: "scott/top" });
  move();

  expect(
    await requestReview(ctx, {
      threadId: "t1",
      environmentId: "env-2",
      branch: "scott/top",
    }),
  ).toEqual({ threadId: "child-2" });
  expect(spawned[1]).toMatchObject({ environment: { type: "reuse", environmentId: "env-2" } });
  expect(spawned[1]!["prompt"]).toContain("cd '/other/repos/api'");
  expect(await reviewRequests(ctx, { threadId: "t1" })).toEqual({
    requests: [{ branch: "scott/top", threadId: "child-2", running: true }],
  });
});
