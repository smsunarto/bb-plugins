import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { oplog } from "./oplog.ts";

test("forwards the repository to the thread's host", async () => {
  const answer = {
    entries: [
      {
        id: "22c2d57fb4e93d0fbb45aad16aea1b513b6596d5",
        operation: "SquashCommit",
        title: "SquashCommit",
        body: null,
        createdAt: "2026-10-08T23:19:39.000Z",
      },
    ],
    reason: null,
  };
  const { ctx, calls } = harness({ result: answer });

  expect(await oplog.execute(ctx, { threadId: "t1" })).toEqual(answer);
  expect(calls).toEqual([
    { method: "oplog", input: { environmentPath: "/work" }, options: { hostId: "host-1" } },
  ]);
});

test("returns no entries with a reason while the environment is not ready", async () => {
  const { ctx, calls } = harness({
    environment: { id: "env-1", hostId: "host-1", path: "/work", status: "starting" },
  });

  expect(await oplog.execute(ctx, { threadId: "t1" })).toEqual({
    entries: [],
    reason: "This thread's environment is starting.",
  });
  expect(calls).toEqual([]);
});
