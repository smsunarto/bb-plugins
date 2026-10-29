import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { workspace } from "./workspace.ts";

const identity = {
  kind: "gitbutler" as const,
  path: "/work",
  branch: "gitbutler/workspace",
  head: "a".repeat(40),
  origin: "github.com/owner/project",
  commonDir: "/work/.git",
};

const ready = {
  state: "ready" as const,
  checkoutIdentity: identity,
  repositoryKey: ".",
  repoName: "bb-plugins",
  unassignedChanges: [],
  stacks: [],
  base: null,
  upstream: null,
  conflictedFiles: [],
};

test("forwards the environment path and host to the host entry, and names the environment and machine", async () => {
  const { ctx, calls } = harness({ result: ready });
  const result = await workspace(ctx, { threadId: "t1" });

  expect(result).toEqual({
    ...ready,
    environmentId: "env-1",
    hostId: "host-1",
    nativeAgentPrompts: null,
  });
  expect(calls).toEqual([
    { method: "workspace", input: { environmentPath: "/work" }, options: { hostId: "host-1" } },
  ]);
});

test("adds server-owned native agent requests to the exact checkout snapshot", async () => {
  const checkoutIdentity = {
    kind: "git" as const,
    path: "/work/it's isolated",
    branch: "scott/isolated",
    head: "a".repeat(40),
    origin: "github.com/owner/project",
    commonDir: "/work/main/.git",
  };
  const { ctx } = harness({ result: { ...ready, checkoutIdentity } });
  const result = await workspace(ctx, { threadId: "t1" });
  if (result.state !== "ready") throw new Error(result.reason);

  expect(result.nativeAgentPrompts?.guidance).toContain('"machine": "host-1"');
  expect(result.nativeAgentPrompts?.guidance).toContain('"path": "/work/it\'s isolated"');
  expect(result.nativeAgentPrompts?.guidance).toContain('"branch": "scott/isolated"');
  expect(result.nativeAgentPrompts?.guidance).toContain('"origin": "github.com/owner/project"');
  expect(result.nativeAgentPrompts?.guidance).toContain("cd '/work/it'\\''s isolated'");
  expect(result.nativeAgentPrompts?.reword).toStartWith(
    "Reword the selected commit using native Git.",
  );
  expect(Object.keys(result.nativeAgentPrompts ?? {})).toEqual([
    "guidance",
    "reword",
    "squash",
    "move",
    "uncommit",
    "commit",
  ]);

  // A GitButler workspace's agent controls run `but` instead.
  const managed = harness({ result: ready });
  expect(await workspace(managed.ctx, { threadId: "t1" })).toMatchObject({
    nativeAgentPrompts: null,
  });
});

test("forwards a chosen repository and omits the key when there is none", async () => {
  const chosen = harness({ result: ready });
  await workspace(chosen.ctx, { threadId: "t1", repositoryKey: "repos/app" });
  expect(chosen.calls[0]?.input).toEqual({
    environmentPath: "/work",
    repositoryKey: "repos/app",
  });

  const unchosen = harness({ result: ready });
  await workspace(unchosen.ctx, { threadId: "t1" });
  // bb's test host rejects an undefined value and the real one drops it, so
  // the key is left out rather than sent as undefined.
  expect(Object.keys(unchosen.calls[0]?.input as object)).toEqual(["environmentPath"]);
});

test("explains a thread with no environment instead of calling the host", async () => {
  const { ctx, calls } = harness({ environment: null });
  const result = await workspace(ctx, { threadId: "t1" });

  expect(result).toEqual({
    state: "noEnvironment",
    reason: "This thread has no project environment.",
    environmentId: null,
    repositoryKey: null,
  });
  expect(calls).toEqual([]);
});

test("explains an environment that is not ready yet", async () => {
  const { ctx, calls } = harness({
    environment: { hostId: "host-1", path: "/work", status: "starting" },
  });
  const result = await workspace(ctx, { threadId: "t1" });

  expect(result).toMatchObject({ reason: "This thread's environment is starting." });
  expect(calls).toEqual([]);
});

test("names a disconnected host as an error answer instead of throwing", async () => {
  const { ctx } = harness({
    error: new Error("Host is not connected"),
    host: { name: "Local Mac", status: "disconnected" },
  });
  const result = await workspace(ctx, { threadId: "t1" });

  expect(result).toEqual({
    state: "error",
    reason: "Local Mac is not connected. The workspace loads when it reconnects.",
    environmentId: "env-1",
    repositoryKey: null,
  });
});

test("rethrows a failure on a host that is still connected", async () => {
  const { ctx } = harness({
    error: new Error("but exited with code 1"),
    host: { name: "Local Mac", status: "connected" },
  });

  await expect(workspace(ctx, { threadId: "t1" })).rejects.toThrow("but exited with code 1");
});
