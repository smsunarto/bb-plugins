import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { commit } from "./commit.ts";

const details = {
  commitId: "8f4598a1",
  message: "feat: thing",
  authorName: "Ada",
  authorEmail: "ada@example.com",
  files: [],
};

test("forwards the commit id to the host entry", async () => {
  const { ctx, calls } = harness({ result: details });

  expect(await commit.execute(ctx, { threadId: "t1", commitId: "8f4598a1" })).toEqual(details);
  expect(calls[0]?.input).toEqual({ environmentPath: "/work", commitId: "8f4598a1" });
});

test("fails loudly when the thread has no environment", async () => {
  const { ctx } = harness({ environment: null });

  expect(commit.execute(ctx, { threadId: "t1", commitId: "8f4598a1" })).rejects.toThrow(
    "This thread has no project environment.",
  );
});
