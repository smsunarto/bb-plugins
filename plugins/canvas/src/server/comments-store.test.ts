import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CommentThread } from "../shared/comments.ts";
import type { CanvasSource } from "../shared/document.ts";
import {
  applyCommentOp,
  applyOp,
  commentsInstructions,
  CommentsError,
  readComments,
  resetCommentsInstructions,
} from "./comments-store.ts";
import { fakeBb, fileKeyOf } from "./fake-bb.ts";

const source: CanvasSource = { kind: "host", hostId: null, path: "/w/a.canvas.mdx" };
const sidecarKey = fileKeyOf(undefined, undefined, "/w/a.canvas.mdx.comments.json");

const thread: CommentThread = {
  id: "cmt_abcdefghij",
  anchor: { blockId: "0123456789ab", index: 0, quote: null, preview: "Title" },
  resolvedAtMs: null,
  messages: [{ id: "msg_1", author: "user", body: "Look here.", createdAtMs: 1 }],
};
const other: CommentThread = { ...thread, id: "cmt_klmnopqrst" };
const reply = { id: "msg_2", author: "agent", body: "Fixed.", createdAtMs: 2 } as const;

test("readComments reads the sidecar beside the canvas and treats a missing one as empty", async () => {
  const bb = fakeBb({});
  const read = await readComments(bb, source);
  assert.deepEqual(read, {
    file: { version: 1, threads: [] },
    sha256: null,
    malformed: false,
    sidecarPath: "/w/a.canvas.mdx.comments.json",
  });
  assert.deepEqual(bb.calls.filesRead, [{ path: "/w/a.canvas.mdx.comments.json" }]);
});

test("readComments keeps the host and root fence of the canvas location", async () => {
  const bb = fakeBb({
    environments: { env1: { hostId: "host-a", path: "/repo" } },
    files: {
      [fileKeyOf("host-a", "/repo", "/repo/n/a.canvas.mdx.comments.json")]: {
        content: JSON.stringify({ version: 1, threads: [thread] }),
        sha256: "s1",
      },
    },
  });
  const read = await readComments(bb, {
    kind: "workspace",
    environmentId: "env1",
    path: "n/a.canvas.mdx",
  });
  assert.equal(read.sha256, "s1");
  assert.deepEqual(read.file.threads, [thread]);
  assert.deepEqual(bb.calls.filesRead, [
    { hostId: "host-a", rootPath: "/repo", path: "/repo/n/a.canvas.mdx.comments.json" },
  ]);
});

test("a malformed sidecar reads as empty and refuses writes", async () => {
  const bb = fakeBb({ files: { [sidecarKey]: { content: "{not json", sha256: "bad" } } });
  const read = await readComments(bb, source);
  assert.deepEqual(read.file, { version: 1, threads: [] });
  assert.equal(read.malformed, true);
  await assert.rejects(
    applyCommentOp(bb, source, { op: "open", thread }),
    (error: unknown) =>
      error instanceof CommentsError && /not a valid comments file/.test(error.message),
  );
  assert.equal(bb.calls.filesWrite.length, 0);
});

test("applyOp is idempotent for open, reply, and resolve", () => {
  const empty = { version: 1, threads: [] } as const;
  const opened = applyOp(empty, { op: "open", thread }, 10);
  assert.equal(applyOp(opened, { op: "open", thread }, 11), opened);
  const replied = applyOp(opened, { op: "reply", threadId: thread.id, message: reply }, 12);
  assert.deepEqual(replied.threads[0]?.messages, [thread.messages[0], reply]);
  assert.equal(applyOp(replied, { op: "reply", threadId: thread.id, message: reply }, 13), replied);
  const resolved = applyOp(replied, { op: "resolve", threadId: thread.id, resolved: true }, 14);
  assert.equal(resolved.threads[0]?.resolvedAtMs, 14);
  assert.equal(
    applyOp(resolved, { op: "resolve", threadId: thread.id, resolved: true }, 15),
    resolved,
  );
  const reopened = applyOp(resolved, { op: "resolve", threadId: thread.id, resolved: false }, 16);
  assert.equal(reopened.threads[0]?.resolvedAtMs, null);
  assert.throws(
    () => applyOp(empty, { op: "reply", threadId: "cmt_zzzzzzzzzz", message: reply }, 1),
    /unknown comment thread cmt_zzzzzzzzzz/,
  );
});

test("applyCommentOp writes with compare-and-swap, publishes, and skips no-op writes", async () => {
  const bb = fakeBb({});
  const first = await applyCommentOp(bb, source, { op: "open", thread });
  assert.deepEqual(first.file.threads, [thread]);
  assert.equal(bb.calls.filesWrite[0]?.expectedSha256, null);
  assert.equal(bb.calls.filesWrite[0]?.path, "/w/a.canvas.mdx.comments.json");
  const again = await applyCommentOp(bb, source, { op: "open", thread });
  assert.equal(again.sha256, first.sha256);
  assert.equal(bb.calls.filesWrite.length, 1);
  const replied = await applyCommentOp(bb, source, {
    op: "reply",
    threadId: thread.id,
    message: reply,
  });
  assert.equal(bb.calls.filesWrite[1]?.expectedSha256, first.sha256);
  assert.deepEqual(bb.calls.published, [
    {
      channel: "canvas:comments",
      payload: { sidecarPath: "/w/a.canvas.mdx.comments.json", sha256: first.sha256 },
    },
    {
      channel: "canvas:comments",
      payload: { sidecarPath: "/w/a.canvas.mdx.comments.json", sha256: replied.sha256 },
    },
  ]);
  const stored = bb.store.get(sidecarKey);
  assert.ok(stored !== undefined && !(stored instanceof Error));
  assert.deepEqual(JSON.parse(stored.content), replied.file);
  assert.ok(stored.content.endsWith("\n"));
});

test("applyCommentOp re-reads and re-applies after a concurrent write", async () => {
  let interfered = false;
  const bb = fakeBb({
    beforeWrite(_args, store) {
      if (interfered) return;
      interfered = true;
      store.set(sidecarKey, {
        content: JSON.stringify({ version: 1, threads: [other] }),
        sha256: "theirs",
      });
    },
  });
  const result = await applyCommentOp(bb, source, { op: "open", thread });
  assert.deepEqual(
    result.file.threads.map((t) => t.id),
    [other.id, thread.id],
  );
  assert.equal(bb.calls.filesWrite.length, 2);
  assert.equal(bb.calls.filesWrite[1]?.expectedSha256, "theirs");
  assert.equal(bb.calls.published.length, 1);
});

test("applyCommentOp gives up after three conflicts", async () => {
  let n = 0;
  const bb = fakeBb({
    beforeWrite(_args, store) {
      n += 1;
      store.set(sidecarKey, {
        content: JSON.stringify({ version: 1, threads: [] }),
        sha256: `v${n}`,
      });
    },
  });
  await assert.rejects(applyCommentOp(bb, source, { op: "open", thread }), /changed 3 times/);
  assert.equal(bb.calls.filesWrite.length, 3);
});

test("thread-storage writes feed the agent instructions line until every thread is resolved", async () => {
  resetCommentsInstructions();
  const bb = fakeBb({ threads: { t1: { hostId: "h", storageRootPath: "/store/t1" } } });
  const stored: CanvasSource = {
    kind: "thread-storage",
    threadId: "t1",
    path: "canvases/r.canvas.mdx",
  };
  assert.equal(commentsInstructions("t1"), null);
  await applyCommentOp(bb, stored, { op: "open", thread });
  assert.equal(
    commentsInstructions("t1"),
    "Open canvas comments: /store/t1/canvases/r.canvas.mdx (1). Read them with `bb canvas comments /store/t1/canvases/r.canvas.mdx`.",
  );
  assert.equal(commentsInstructions("t2"), null);
  await applyCommentOp(bb, stored, { op: "resolve", threadId: thread.id, resolved: true });
  assert.equal(commentsInstructions("t1"), null);
  await applyCommentOp(bb, source, { op: "open", thread });
  assert.equal(commentsInstructions("t1"), null, "host canvases are not tracked");
});
