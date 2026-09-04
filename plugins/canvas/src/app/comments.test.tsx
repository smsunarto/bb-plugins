import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";
import type { ReactElement } from "react";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { parseCanvas } from "../server/parse.ts";
import { anchorAt, flattenBlocks } from "../shared/anchor.ts";
import type { CommentOp, CommentsFile, CommentThread } from "../shared/comments.ts";
import type { CanvasDocument, RenderOutput } from "../shared/document.ts";
import { applyOp } from "../shared/ops.ts";

installDom();
mock.module("@pierre/diffs/react", () => ({ FileDiff: () => <div /> }));
const { fireEvent, waitFor } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { CanvasOpener } = await import("./canvas.tsx");
const { relativeTime } = await import("./comments.tsx");

const source = '# Title\n\nFirst paragraph here.\n\n<Stat label="Runs" value={200} />\n';
const parsed = parseCanvas(source);
if (!parsed.ok) throw new Error("fixture does not parse");
const document: CanvasDocument = parsed.document;
const [, paragraph, stat] = flattenBlocks(document);
if (paragraph === undefined || stat === undefined) throw new Error("fixture blocks");

const onParagraph: CommentThread = {
  id: "cmt_abcdefghij",
  anchor: anchorAt(document, paragraph.offset, "paragraph"),
  resolvedAtMs: null,
  messages: [{ id: "msg_1", author: "user", body: "Look here.\nMore.", createdAtMs: Date.now() }],
};
const gone: CommentThread = {
  id: "cmt_klmnopqrst",
  anchor: { blockId: "ffffffffffff", index: 4, quote: null, preview: "Old text that vanished" },
  resolvedAtMs: null,
  messages: [{ id: "msg_2", author: "agent", body: "Still relevant?", createdAtMs: 1 }],
};
const resolved: CommentThread = {
  ...onParagraph,
  id: "cmt_uvwxyz2345",
  resolvedAtMs: 5,
  messages: [{ id: "msg_3", author: "user", body: "Old note.", createdAtMs: 1 }],
};

function Original(): ReactElement {
  return <pre>ORIGINAL SOURCE</pre>;
}

function propsFor(path: string): PluginFileOpenerProps {
  return {
    path,
    source: { kind: "thread-storage", threadId: "thread-1", environmentId: null, projectId: null },
    Original,
  };
}

const rendered: RenderOutput = { status: "rendered", sha256: "sha-1", modifiedAtMs: 1, document };

// The query client is a module singleton, so each harness gets its own path
// the same way canvas.test.tsx does.
let harnesses = 0;

function harness(threads: readonly CommentThread[]) {
  harnesses += 1;
  let file: CommentsFile = { version: 1, threads };
  let sha = `c${harnesses}`;
  const ops: CommentOp[] = [];
  let loads = 0;
  const slot = renderSlot(
    { component: CanvasOpener },
    propsFor(`canvases/c${harnesses}.canvas.mdx`),
    {
      rpc: {
        render: () => rendered,
        state: () => ({ values: {}, revision: 0 }),
        comments: (input) => {
          loads += 1;
          const known = (input as { knownSha256: string | null }).knownSha256;
          if (known === sha) return { status: "unchanged", sha256: sha };
          return { status: "loaded", sha256: sha, file, malformed: false };
        },
        comment: (input) => {
          const op = (input as { op: CommentOp }).op;
          ops.push(op);
          file = applyOp(file, op, 9);
          sha = `w${ops.length}`;
          return { sha256: sha, file };
        },
      },
    },
  );
  return { slot, ops, loads: () => loads };
}

test("a block with a thread shows the count badge and a collapsed card", async () => {
  const { slot } = harness([onParagraph]);
  await slot.findByText("Look here.");
  const badge = slot.container.querySelector(".canvas-comment-add[data-count]");
  assert.equal(badge?.textContent, "1");
  assert.ok(
    slot.container
      .querySelector(".canvas-commented")
      ?.textContent?.includes("First paragraph here."),
  );
  assert.ok(slot.getByText("You"));
  assert.equal(slot.queryByText("More."), null, "collapsed card shows the first line only");
  assert.equal(slot.container.textContent?.includes("1 open comment"), true);
  slot.unmount();
});

test("submitting the composer opens a thread anchored to that block", async () => {
  const { slot, ops } = harness([]);
  await slot.findByText("Runs");
  const buttons = slot.getAllByLabelText("Comment on this block");
  assert.equal(buttons.length, 3);
  fireEvent.click(buttons[2] as HTMLElement);
  const textarea = slot.getByPlaceholderText("Add a comment");
  fireEvent.change(textarea, { target: { value: "Is 200 right?" } });
  fireEvent.click(slot.getByRole("button", { name: "Comment" }));
  await waitFor(() => assert.equal(ops.length, 1));
  const op = ops[0];
  assert.equal(op?.op, "open");
  if (op?.op === "open") {
    assert.deepEqual(op.thread.anchor, anchorAt(document, stat.offset, null));
    assert.equal(op.thread.messages[0].body, "Is 200 right?");
    assert.equal(op.thread.messages[0].author, "user");
    assert.match(op.thread.id, /^cmt_[a-z2-7]{10}$/);
  }
  await slot.findByText("Is 200 right?");
  slot.unmount();
});

test("resolve sends a resolve op and the thread hides until Show resolved", async () => {
  const { slot, ops } = harness([onParagraph]);
  await slot.findByText("Look here.");
  fireEvent.click(slot.getByRole("button", { name: /Look here/u }));
  fireEvent.click(slot.getByRole("button", { name: "Resolve" }));
  await waitFor(() => assert.equal(ops.length, 1));
  assert.deepEqual(ops[0], { op: "resolve", threadId: onParagraph.id, resolved: true });
  await waitFor(() => assert.equal(slot.queryByText("More."), null));
  fireEvent.click(await slot.findByRole("button", { name: "Show resolved (1)" }));
  await slot.findByText("Resolved");
  slot.unmount();
});

test("a detached thread renders in the detached section with its saved preview", async () => {
  const { slot } = harness([gone, resolved]);
  await slot.findByText("Detached comments");
  fireEvent.click(slot.getByRole("button", { name: /Still relevant/u }));
  await slot.findByText("Was: Old text that vanished");
  assert.ok(slot.getAllByText("Agent").length >= 1);
  assert.equal(slot.queryByText("Old note."), null, "resolved threads hide by default");
  assert.equal(slot.container.querySelector(".canvas-commented"), null);
  slot.unmount();
});

test("a realtime comments signal refetches the comments query", async () => {
  const { slot, loads } = harness([]);
  await slot.findByText("Runs");
  await waitFor(() => assert.ok(loads() >= 1));
  const before = loads();
  await slot.emitRealtime("canvas:comments", { sidecarPath: "/x.comments.json", sha256: "other" });
  await waitFor(() => assert.ok(loads() > before), { timeout: 800 });
  slot.unmount();
});

test("relativeTime steps from just now to a date", () => {
  const now = Date.UTC(2026, 8, 3, 12);
  assert.equal(relativeTime(now - 5_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(
    relativeTime(now - 30 * 86_400_000, now),
    new Date(now - 30 * 86_400_000).toLocaleDateString(),
  );
});
