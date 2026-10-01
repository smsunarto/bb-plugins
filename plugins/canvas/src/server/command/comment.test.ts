import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CommentThread } from "../../shared/comments.ts";
import { fakeBb, fileKeyOf, runCanvasCli } from "../fake-bb.ts";

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

const usage =
  "Usage:\n  bb canvas comment <path> <threadId> [--reply <text>] [--resolve] [--reopen]\n";

test("comment --reply --resolve appends an agent message and resolves the thread", async () => {
  const bb = bbWith([thread]);
  const result = await runCanvasCli(
    bb,
    ["comment", "a.canvas.mdx", thread.id, "--reply", "Verified 4m02s, table fixed.", "--resolve"],
    { cwd: "/w" },
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "cmt_abcdefghij: replied, resolved\n",
    stderr: "",
  });
  const [saved] = stored(bb).threads;
  assert.equal(saved?.messages.length, 2);
  assert.equal(saved?.messages[1]?.author, "agent");
  assert.equal(saved?.messages[1]?.body, "Verified 4m02s, table fixed.");
  assert.match(saved?.messages[1]?.id ?? "", /^msg_[a-z2-7]{10}$/);
  assert.equal(typeof saved?.resolvedAtMs, "number");
});

test("comment --reopen clears resolvedAtMs", async () => {
  const bb = bbWith([{ ...thread, resolvedAtMs: 5 }]);
  const result = await runCanvasCli(bb, ["comment", "/w/a.canvas.mdx", thread.id, "--reopen"]);
  assert.equal(result.stdout, "cmt_abcdefghij: reopened\n");
  assert.equal(stored(bb).threads[0]?.resolvedAtMs, null);
});

test("comment rejects an empty request, conflicting flags, an empty reply, and an unknown thread", async () => {
  const bb = bbWith([thread]);
  const run = (...flags: string[]) =>
    runCanvasCli(bb, ["comment", "/w/a.canvas.mdx", thread.id, ...flags]);
  assert.deepEqual(await run(), {
    exitCode: 1,
    stdout: "",
    stderr: `missing required options: one of --reply, --resolve, --reopen\n\n${usage}`,
  });
  assert.deepEqual(await run("--resolve", "--reopen"), {
    exitCode: 1,
    stdout: "",
    stderr: `--resolve and --reopen cannot be combined (Pass at most one of: --resolve, --reopen)\n\n${usage}`,
  });
  assert.deepEqual(await run("--reply", ""), {
    exitCode: 1,
    stdout: "",
    stderr: "--reply needs text\n",
  });
  assert.deepEqual(
    await runCanvasCli(bb, ["comment", "/w/a.canvas.mdx", "cmt_zzzzzzzzzz", "--resolve"]),
    {
      exitCode: 1,
      stdout: "",
      stderr: "/w/a.canvas.mdx: unknown comment thread cmt_zzzzzzzzzz\n",
    },
  );
  assert.equal(bb.calls.filesWrite.length, 0);
});
