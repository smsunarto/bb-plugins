import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CommentThread } from "../../shared/comments.ts";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb } from "../fake-bb.ts";
import { comment } from "./comment.ts";
import { comments } from "./comments.ts";

const source: CanvasSource = { kind: "host", hostId: null, path: "/w/a.canvas.mdx" };
const thread: CommentThread = {
  id: "cmt_abcdefghij",
  anchor: { blockId: "0123456789ab", index: 0, quote: null, preview: "Title" },
  resolvedAtMs: null,
  messages: [{ id: "msg_1", author: "user", body: "Look here.", createdAtMs: 1 }],
};

test("comment applies an op and returns the sha the query then treats as known", async () => {
  const bb = fakeBb({});
  const written = await comment.execute({ bb }, { source, op: { op: "open", thread } });
  assert.deepEqual(written.file.threads, [thread]);
  assert.deepEqual(await comments.execute({ bb }, { source, knownSha256: written.sha256 }), {
    status: "unchanged",
    sha256: written.sha256,
  });
  const resolved = await comment.execute(
    { bb },
    { source, op: { op: "resolve", threadId: thread.id, resolved: true } },
  );
  assert.equal(typeof resolved.file.threads[0]?.resolvedAtMs, "number");
  assert.notEqual(resolved.sha256, written.sha256);
});

test("comment surfaces an unknown thread as an error", async () => {
  const bb = fakeBb({});
  await assert.rejects(
    () =>
      Promise.resolve(
        comment.execute(
          { bb },
          { source, op: { op: "resolve", threadId: "cmt_zzzzzzzzzz", resolved: true } },
        ),
      ),
    /unknown comment thread cmt_zzzzzzzzzz/,
  );
});
