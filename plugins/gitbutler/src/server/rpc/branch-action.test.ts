import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { branchAction } from "./branch-action.ts";

test("forwards the action to the thread's host with room for a slow push", async () => {
  const { ctx, calls } = harness({ result: { ok: true } });
  const action = { kind: "push" as const, branch: "scott/top", force: false };

  expect(await branchAction.execute(ctx, { threadId: "t1", action })).toEqual({ ok: true });
  expect(calls[0]).toEqual({
    method: "branchAction",
    input: { environmentPath: "/work", action },
    options: { hostId: "host-1", timeoutMs: 300_000 },
  });
});

test("does not reach a host when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });
  const action = { kind: "land" as const, branch: "scott/top" };

  expect(branchAction.execute(ctx, { threadId: "t1", action })).rejects.toThrow(
    "This thread has no project environment.",
  );
  expect(calls).toHaveLength(0);
});
