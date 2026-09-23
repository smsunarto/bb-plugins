import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { repositories } from "./repositories.ts";

test("returns the host's repository list", async () => {
  const listed = { repositories: [{ key: ".", name: "bb-plugins" }], reason: null };
  const { ctx, calls } = harness({ result: listed });

  expect(await repositories.execute(ctx, { threadId: "t1" })).toEqual(listed);
  expect(calls[0]).toEqual({
    method: "repositories",
    input: { environmentPath: "/work" },
    options: { hostId: "host-1" },
  });
});

test("returns an empty list with a reason when the thread has no environment", async () => {
  const { ctx, calls } = harness({ environment: null });

  expect(await repositories.execute(ctx, { threadId: "t1" })).toEqual({
    repositories: [],
    reason: "This thread has no project environment.",
  });
  expect(calls).toEqual([]);
});
