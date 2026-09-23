import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { workspace } from "./workspace.ts";

const ready = {
  state: "ready" as const,
  reason: null,
  repoName: "bb-plugins",
  unassignedChanges: [],
  stacks: [],
  base: null,
  upstream: null,
  revision: "r1",
};

test("forwards the environment path and host to the host entry", async () => {
  const { ctx, calls } = harness({ result: ready });
  const result = await workspace.execute(ctx, { threadId: "t1" });

  expect(result).toEqual(ready);
  expect(calls).toEqual([
    { method: "workspace", input: { environmentPath: "/work" }, options: { hostId: "host-1" } },
  ]);
});

test("forwards a chosen repository and omits the key when there is none", async () => {
  const chosen = harness({ result: ready });
  await workspace.execute(chosen.ctx, { threadId: "t1", repositoryKey: "repos/app" });
  expect(chosen.calls[0]?.input).toEqual({
    environmentPath: "/work",
    repositoryKey: "repos/app",
  });

  const unchosen = harness({ result: ready });
  await workspace.execute(unchosen.ctx, { threadId: "t1" });
  // The host input is `.strict()`, so an explicit undefined would be rejected.
  expect(Object.keys(unchosen.calls[0]?.input as object)).toEqual(["environmentPath"]);
});

test("explains a thread with no environment instead of calling the host", async () => {
  const { ctx, calls } = harness({ environment: null });
  const result = await workspace.execute(ctx, { threadId: "t1" });

  expect(result.state).toBe("noEnvironment");
  expect(result.reason).toBe("This thread has no project environment.");
  expect(calls).toEqual([]);
});

test("explains an environment that is not ready yet", async () => {
  const { ctx, calls } = harness({
    environment: { hostId: "host-1", path: "/work", status: "starting" },
  });
  const result = await workspace.execute(ctx, { threadId: "t1" });

  expect(result.reason).toBe("This thread's environment is starting.");
  expect(calls).toEqual([]);
});
