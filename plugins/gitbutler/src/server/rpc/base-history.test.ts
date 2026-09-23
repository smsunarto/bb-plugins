import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { baseHistory } from "./base-history.ts";

const input = { threadId: "t1", from: "654681d0", offset: 0, limit: 60 };

test("forwards the paging window to the host entry", async () => {
  const { ctx, calls } = harness({ result: { commits: [], hasMore: false, reason: null } });
  await baseHistory.execute(ctx, input);

  expect(calls[0]?.input).toEqual({
    environmentPath: "/work",
    from: "654681d0",
    offset: 0,
    limit: 60,
  });
});

test("returns an empty page with a reason when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });

  expect(await baseHistory.execute(ctx, input)).toEqual({
    commits: [],
    hasMore: false,
    reason: "This thread has no project environment.",
  });
  expect(calls).toEqual([]);
});
