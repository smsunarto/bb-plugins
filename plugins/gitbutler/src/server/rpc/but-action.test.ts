import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { butAction } from "./but-action.ts";

test("forwards the action to the thread's host with room for a slow push", async () => {
  const { ctx, calls } = harness({ result: { result: { status: "done" }, board: null } });
  const action = { kind: "push" as const, branch: "scott/top", force: false, acceptedLoss: [] };

  expect(await butAction.execute(ctx, { threadId: "t1", action })).toEqual({
    result: { status: "done" },
    workspace: null,
  });
  expect(calls[0]).toEqual({
    method: "butAction",
    input: { environmentPath: "/work", action },
    options: { hostId: "host-1", timeoutMs: 300_000 },
  });
});

test("forwards the workspace pull, which names no branch, and the host's question", async () => {
  const question = {
    status: "confirm" as const,
    risk: { conflicted: ["scott/top"], overlapsUncommitted: true },
  };
  const { ctx, calls } = harness({ result: { result: question, board: null } });
  const action = { kind: "updateWorkspace" as const, accepted: null };

  expect(await butAction.execute(ctx, { threadId: "t1", action })).toEqual({
    result: question,
    workspace: null,
  });
  expect(calls[0]?.input).toEqual({ environmentPath: "/work", action });
});

test("does not reach a host when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });
  const action = { kind: "land" as const, branch: "scott/top", message: null, accepted: null };

  expect(butAction.execute(ctx, { threadId: "t1", action })).rejects.toThrow(
    "This thread has no project environment.",
  );
  expect(calls).toHaveLength(0);
});

test("refuses a write aimed at a board read in another environment", async () => {
  const { ctx, calls } = harness({ result: { result: { status: "done" }, board: null } });
  const action = { kind: "land" as const, branch: "scott/top", message: null, accepted: null };

  await expect(
    butAction.execute(ctx, { threadId: "t1", environmentId: "env-old", action }),
  ).rejects.toThrow("This thread moved to another environment since the board was read.");
  expect(calls).toHaveLength(0);
  expect(await butAction.execute(ctx, { threadId: "t1", environmentId: "env-1", action })).toEqual({
    result: { status: "done" },
    workspace: null,
  });
});

test("hands back the board the write left, as the panel draws it", async () => {
  const board = {
    state: "ready" as const,
    reason: null,
    repositoryKey: ".",
    repoName: "api",
    unassignedChanges: [],
    stacks: [],
    base: null,
    upstream: null,
    conflictedFiles: [],
  };
  const { ctx, calls } = harness({ result: { result: { status: "done" }, board } });
  const action = { kind: "delete" as const, branch: "scott/top", accepted: null };

  expect(await butAction.execute(ctx, { threadId: "t1", action })).toEqual({
    result: { status: "done" },
    workspace: { ...board, environmentId: "env-1", hostId: "host-1" },
  });
  // One host call: no read of the board before or after.
  expect(calls.map(({ method }) => method)).toEqual(["butAction"]);
});
