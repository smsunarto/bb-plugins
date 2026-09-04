import { test } from "bun:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/command";
import type { CommentThread } from "../../shared/comments.ts";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { comment } from "./comment.ts";

const thread: CommentThread = {
  id: "cmt_abcdefghij",
  anchor: { blockId: "0123456789ab", index: 0, quote: null, preview: "Title" },
  resolvedAtMs: null,
  messages: [{ id: "msg_1", author: "user", body: "Look here.", createdAtMs: 1 }],
};
const sidecarKey = fileKeyOf(undefined, undefined, "/w/a.canvas.mdx.comments.json");

function bbWith(threads: readonly CommentThread[]) {
  return fakeBb({ files: { [sidecarKey]: { content: JSON.stringify({ version: 1, threads }) } } });
}

function stored(bb: ReturnType<typeof fakeBb>) {
  const file = bb.store.get(sidecarKey);
  if (file === undefined || file instanceof Error) throw new Error("no sidecar");
  return JSON.parse(file.content) as { threads: CommentThread[] };
}

test("comment --reply --resolve appends an agent message and resolves the thread", async () => {
  const bb = bbWith([thread]);
  const result = await comment.execute(
    { bb, cwd: "/w" },
    {
      path: "a.canvas.mdx",
      threadId: thread.id,
      reply: "Verified 4m02s, table fixed.",
      resolve: true,
    },
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "cmt_abcdefghij: replied, resolved\n" });
  const [saved] = stored(bb).threads;
  assert.equal(saved?.messages.length, 2);
  assert.equal(saved?.messages[1]?.author, "agent");
  assert.equal(saved?.messages[1]?.body, "Verified 4m02s, table fixed.");
  assert.match(saved?.messages[1]?.id ?? "", /^msg_[a-z2-7]{10}$/);
  assert.equal(typeof saved?.resolvedAtMs, "number");
});

test("comment --reopen clears resolvedAtMs", async () => {
  const bb = bbWith([{ ...thread, resolvedAtMs: 5 }]);
  const result = await comment.execute(
    { bb },
    { path: "/w/a.canvas.mdx", threadId: thread.id, reopen: true },
  );
  assert.equal(result.stdout, "cmt_abcdefghij: reopened\n");
  assert.equal(stored(bb).threads[0]?.resolvedAtMs, null);
});

test("comment rejects an empty request, conflicting flags, and an unknown thread", async () => {
  const bb = bbWith([thread]);
  await assert.rejects(
    () =>
      Promise.resolve(comment.execute({ bb }, { path: "/w/a.canvas.mdx", threadId: thread.id })),
    (error: unknown) => error instanceof CommandError && /nothing to do/.test(error.message),
  );
  await assert.rejects(
    () =>
      Promise.resolve(
        comment.execute(
          { bb },
          { path: "/w/a.canvas.mdx", threadId: thread.id, resolve: true, reopen: true },
        ),
      ),
    (error: unknown) => error instanceof CommandError && /exclude each other/.test(error.message),
  );
  await assert.rejects(
    () =>
      Promise.resolve(
        comment.execute(
          { bb },
          { path: "/w/a.canvas.mdx", threadId: "cmt_zzzzzzzzzz", resolve: true },
        ),
      ),
    (error: unknown) =>
      error instanceof CommandError &&
      error.exitCode === 1 &&
      /unknown comment thread cmt_zzzzzzzzzz/.test(error.message),
  );
  assert.equal(bb.calls.filesWrite.length, 0);
});
