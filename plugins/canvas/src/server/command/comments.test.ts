import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CommandError } from "@bb-kit/core/command";
import { anchorAt, flattenBlocks } from "../../shared/anchor.ts";
import type { CommentThread } from "../../shared/comments.ts";
import { parseCanvas } from "../parse.ts";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { formatWhen } from "../format.ts";
import { comments } from "./comments.ts";

const sample = readFileSync(
  new URL("../../../examples/flaky-test-triage.canvas.mdx", import.meta.url),
  "utf8",
);
const parsed = parseCanvas(sample);
if (!parsed.ok) throw new Error("sample does not parse");
const document = parsed.document;
const tableOffset = flattenBlocks(document).find((b) => b.label.startsWith("Table"))?.offset ?? -1;
const today = Date.now();

const onTable: CommentThread = {
  id: "cmt_7f3k2a9x1p",
  anchor: anchorAt(document, tableOffset, "dev-instance | 22% | 4m12s"),
  resolvedAtMs: null,
  messages: [
    {
      id: "msg_1",
      author: "user",
      body: "This rerun time looks wrong, check the log.",
      createdAtMs: today,
    },
  ],
};
const detached: CommentThread = {
  id: "cmt_b2n8h4qk0d",
  anchor: {
    blockId: "ffffffffffff",
    index: 1,
    quote: "gone",
    preview: "account for 78% of the noise",
  },
  resolvedAtMs: null,
  messages: [
    { id: "msg_2", author: "user", body: "Cite the source for this number.", createdAtMs: today },
  ],
};
const resolved: CommentThread = {
  id: "cmt_resolved00",
  anchor: anchorAt(document, 0, null),
  resolvedAtMs: today,
  messages: [
    { id: "msg_3", author: "user", body: "Title case?", createdAtMs: 0 },
    { id: "msg_4", author: "agent", body: "Done.\nSecond line.", createdAtMs: today },
  ],
};

function bbWith(threads: readonly CommentThread[]) {
  return fakeBb({
    files: {
      [fileKeyOf(undefined, undefined, "/w/report.canvas.mdx")]: { content: sample },
      [fileKeyOf(undefined, undefined, "/w/report.canvas.mdx.comments.json")]: {
        content: JSON.stringify({ version: 1, threads }),
      },
    },
  });
}

test("comments prints open threads in block order with the resolved count hidden", async () => {
  const bb = bbWith([detached, resolved, onTable]);
  const result = await comments.execute({ bb, cwd: "/w" }, { path: "report.canvas.mdx" });
  const hhmm = formatWhen(today, today);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: [
      "2 open comments in report.canvas.mdx (1 resolved, hidden; pass --all)",
      "",
      'cmt_7f3k2a9x1p  open  block 10 Table "Top offenders, ranked by rerun cost"',
      '  quote  "dev-instance | 22% | 4m12s"',
      `  user   ${hhmm}  This rerun time looks wrong, check the log.`,
      "cmt_b2n8h4qk0d  open  detached (the block is no longer in the file)",
      '  was    "account for 78% of the noise"',
      `  user   ${hhmm}  Cite the source for this number.`,
      "",
    ].join("\n"),
  });
});

test("comments --all shows resolved threads, edited flags, dates, and multi-line bodies", async () => {
  const edited = { ...onTable, anchor: { ...onTable.anchor, quote: "dev-instance | 99% | 4m12s" } };
  const bb = bbWith([resolved, edited]);
  const result = await comments.execute({ bb }, { path: "/w/report.canvas.mdx", all: true });
  const lines = (result.stdout ?? "").split("\n");
  assert.equal(lines[0], "2 comments in report.canvas.mdx (1 open)");
  assert.equal(
    lines[2],
    'cmt_resolved00  resolved  block 1 markdown "# Flaky test triage for bb-plugins CI"',
  );
  assert.equal(lines[3], `  user   ${formatWhen(0, today)}  Title case?`);
  assert.equal(lines[4], `  agent  ${formatWhen(today, today)}  Done.`);
  assert.equal(lines[5], "                Second line.");
  assert.match(
    lines[6] ?? "",
    /^cmt_7f3k2a9x1p  open  block 10 Table "Top offenders, ranked by rerun cost"  edited since$/,
  );
});

test("comments --json prints the placed threads", async () => {
  const bb = bbWith([onTable, resolved]);
  const result = await comments.execute({ bb }, { path: "/w/report.canvas.mdx", json: true });
  const report = JSON.parse(result.stdout ?? "");
  assert.equal(report.path, "/w/report.canvas.mdx");
  assert.equal(report.sidecarPath, "/w/report.canvas.mdx.comments.json");
  assert.equal(report.parses, true);
  assert.deepEqual(
    report.threads.map((t: { thread: { id: string } }) => t.thread.id),
    ["cmt_7f3k2a9x1p"],
  );
  assert.deepEqual(report.threads[0].match, {
    kind: "anchored",
    offset: tableOffset,
    index: 9,
    editedSince: false,
  });
});

test("comments exits 0 with a plain line when nothing is commented", async () => {
  const bb = fakeBb({
    files: { [fileKeyOf(undefined, undefined, "/w/report.canvas.mdx")]: { content: sample } },
  });
  const result = await comments.execute({ bb }, { path: "/w/report.canvas.mdx" });
  assert.deepEqual(result, { exitCode: 0, stdout: "No comments in report.canvas.mdx.\n" });
});

test("comments exits 2 when the canvas is unreadable or the sidecar is malformed", async () => {
  await assert.rejects(
    () => Promise.resolve(comments.execute({ bb: fakeBb({}) }, { path: "/w/missing.canvas.mdx" })),
    (error: unknown) => error instanceof CommandError && error.exitCode === 2,
  );
  const bb = fakeBb({
    files: {
      [fileKeyOf(undefined, undefined, "/w/report.canvas.mdx")]: { content: sample },
      [fileKeyOf(undefined, undefined, "/w/report.canvas.mdx.comments.json")]: { content: "[]" },
    },
  });
  await assert.rejects(
    () => Promise.resolve(comments.execute({ bb }, { path: "/w/report.canvas.mdx" })),
    (error: unknown) =>
      error instanceof CommandError &&
      error.exitCode === 2 &&
      /not a valid comments file/.test(error.message),
  );
});
