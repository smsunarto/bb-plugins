import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CommentThread } from "../../shared/comments.ts";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { comments } from "./comments.ts";

const source: CanvasSource = { kind: "host", hostId: "host-w", path: "/w/a.canvas.mdx" };
const sidecarKey = fileKeyOf("host-w", undefined, "/w/a.canvas.mdx.comments.json");
const thread: CommentThread = {
  id: "cmt_abcdefghij",
  anchor: { blockId: "0123456789ab", index: 0, quote: null, preview: "Title" },
  resolvedAtMs: null,
  messages: [{ id: "msg_1", author: "user", body: "Look here.", createdAtMs: 1 }],
};

test("comments loads an absent sidecar as empty", async () => {
  assert.deepEqual(await comments.execute({ bb: fakeBb({}) }, { source, knownSha256: null }), {
    status: "loaded",
    sha256: null,
    file: { version: 1, threads: [] },
    malformed: false,
  });
});

test("comments reports unchanged for a known sha and loads otherwise", async () => {
  const bb = fakeBb({
    files: {
      [sidecarKey]: { content: JSON.stringify({ version: 1, threads: [thread] }), sha256: "s1" },
    },
  });
  assert.deepEqual(await comments.execute({ bb }, { source, knownSha256: "s1" }), {
    status: "unchanged",
    sha256: "s1",
  });
  const loaded = await comments.execute({ bb }, { source, knownSha256: "stale" });
  assert.equal(loaded.status, "loaded");
  if (loaded.status === "loaded") assert.deepEqual(loaded.file.threads, [thread]);
});

test("comments flags a malformed sidecar instead of failing", async () => {
  const bb = fakeBb({ files: { [sidecarKey]: { content: "nope" } } });
  const result = await comments.execute({ bb }, { source, knownSha256: null });
  assert.equal(result.status, "loaded");
  if (result.status === "loaded") {
    assert.equal(result.malformed, true);
    assert.deepEqual(result.file.threads, []);
  }
});

test("a poll of an unchanged sidecar on a remote host costs a stamp, not a read", async () => {
  const sidecar = "/Users/me/poll.canvas.mdx.comments.json";
  const remote: CanvasSource = {
    kind: "host",
    hostId: "host-mac",
    path: "/Users/me/poll.canvas.mdx",
  };
  const content = JSON.stringify({ version: 1, threads: [thread] });
  const bb = fakeBb({
    stamps: new Map([[fileKeyOf("host-mac", undefined, sidecar), "stamp-1"]]),
    files: { [fileKeyOf("host-mac", undefined, sidecar)]: { content, sha256: "s1" } },
  });
  const loaded = await comments.execute({ bb }, { source: remote, knownSha256: null });
  assert.equal(loaded.status === "loaded" && loaded.sha256, "s1");
  for (let poll = 0; poll < 3; poll += 1) {
    assert.deepEqual(await comments.execute({ bb }, { source: remote, knownSha256: "s1" }), {
      status: "unchanged",
      sha256: "s1",
    });
  }
  assert.equal(bb.calls.filesRead.length, 2);
  assert.deepEqual(bb.calls.hostCalls.at(-1), {
    hostId: "host-mac",
    method: "stamp",
    input: { path: sidecar },
  });
});
