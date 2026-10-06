import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { butAction } from "./but-action.ts";

test("forwards the action to the thread's host with room for a slow push", async () => {
  const { ctx, calls } = harness({ result: { status: "done" } });
  const action = { kind: "push" as const, branch: "scott/top", force: false, acceptedLoss: [] };

  expect(await butAction.execute(ctx, { threadId: "t1", action })).toEqual({ status: "done" });
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
  const { ctx, calls } = harness({ result: question });
  const action = { kind: "updateWorkspace" as const, accepted: null };

  expect(await butAction.execute(ctx, { threadId: "t1", action })).toEqual(question);
  expect(calls[0]?.input).toEqual({ environmentPath: "/work", action });
});

test("does not reach a host when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });
  const action = { kind: "land" as const, branch: "scott/top" };

  expect(butAction.execute(ctx, { threadId: "t1", action })).rejects.toThrow(
    "This thread has no project environment.",
  );
  expect(calls).toHaveLength(0);
});
