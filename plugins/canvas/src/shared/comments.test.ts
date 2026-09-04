import { test } from "bun:test";
import assert from "node:assert/strict";
import { commentOpSchema, commentsFileSchema } from "./comments.ts";

const thread = {
  id: "cmt_abcdefghij",
  anchor: { blockId: "0123456789ab", index: 0, quote: null, preview: "Title" },
  resolvedAtMs: null,
  messages: [{ id: "msg_1", author: "user", body: "Hi", createdAtMs: 1 }],
};

test("a sidecar needs version 1 and at least one message per thread", () => {
  assert.ok(commentsFileSchema.safeParse({ version: 1, threads: [thread] }).success);
  assert.ok(!commentsFileSchema.safeParse({ version: 2, threads: [] }).success);
  assert.ok(
    !commentsFileSchema.safeParse({ version: 1, threads: [{ ...thread, messages: [] }] }).success,
  );
  assert.ok(
    !commentsFileSchema.safeParse({ version: 1, threads: [{ ...thread, id: "nope" }] }).success,
  );
  assert.ok(
    !commentsFileSchema.safeParse({ version: 1, threads: [{ ...thread, resolvedAtMs: true }] })
      .success,
  );
});

test("comment ops are a closed discriminated union", () => {
  assert.ok(commentOpSchema.safeParse({ op: "open", thread }).success);
  assert.ok(
    commentOpSchema.safeParse({
      op: "reply",
      threadId: thread.id,
      message: { id: "msg_2", author: "agent", body: "Done", createdAtMs: 2 },
    }).success,
  );
  assert.ok(
    commentOpSchema.safeParse({ op: "resolve", threadId: thread.id, resolved: true }).success,
  );
  assert.ok(!commentOpSchema.safeParse({ op: "delete", threadId: thread.id }).success);
  assert.ok(
    !commentOpSchema.safeParse({
      op: "reply",
      threadId: thread.id,
      message: { ...thread.messages[0], author: "bot" },
    }).success,
  );
});
