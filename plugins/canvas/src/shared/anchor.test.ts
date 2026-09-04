import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseCanvas } from "../server/parse.ts";
import {
  anchorAt,
  blockIdOf,
  blockText,
  diceSimilarity,
  flattenBlocks,
  placeThreads,
} from "./anchor.ts";
import type { CommentThread } from "./comments.ts";
import type { CanvasDocument } from "./document.ts";

function documentOf(source: string): CanvasDocument {
  const parsed = parseCanvas(source);
  if (!parsed.ok) throw new Error(parsed.diagnostic.message);
  return parsed.document;
}

const intro =
  "Fourteen suites failed at least once in the last 200 runs. Three of them account for 78% of the noise.";
const table =
  '<Table\n  caption="Top offenders"\n  headers={["Suite", "Fail rate", "Mean rerun"]}\n  rows={[["dev-instance", "22%", "4m12s"], ["screenshots", "17%", "3m05s"]]}\n/>';
const original = `# Title\n\n${intro}\n\n${table}\n\n## The fix\n\nThe teardown handler registers after bootstrap.\n`;

function threadAt(document: CanvasDocument, offset: number, quote: string | null): CommentThread {
  return {
    id: "cmt_abcdefghij",
    anchor: anchorAt(document, offset, quote),
    resolvedAtMs: null,
    messages: [{ id: "msg_1", author: "user", body: "Check this.", createdAtMs: 1 }],
  };
}

function offsets(document: CanvasDocument): readonly number[] {
  return flattenBlocks(document).map((block) => block.offset);
}

test("blockText covers markdown, Stat, Table rows, and Callout children", () => {
  const document = documentOf(
    `${intro}\n\n<Stat label="Runs" value={200} caption="last 9 days" />\n\n${table}\n\n<Callout tone="warning" title="One root cause">\n\nEvery offender leaks port 4317.\n\n</Callout>\n`,
  );
  const [markdown, stat, tableNode, callout] = document.nodes;
  assert.ok(markdown && stat && tableNode && callout);
  assert.equal(blockText(markdown), intro);
  assert.equal(blockText(stat), "Stat\nRuns\n200\nlast 9 days");
  assert.equal(
    blockText(tableNode),
    "Table\nSuite | Fail rate | Mean rerun\ndev-instance | 22% | 4m12s\nscreenshots | 17% | 3m05s\nTop offenders",
  );
  assert.equal(
    blockText(callout),
    "Callout\nwarning\nOne root cause\nEvery offender leaks port 4317.",
  );
});

test("blockIdOf is 12 hex, whitespace-insensitive, and content-sensitive", () => {
  assert.match(blockIdOf("a  b\n c"), /^[0-9a-f]{12}$/);
  assert.equal(blockIdOf("a  b\n c"), blockIdOf("a b c"));
  assert.notEqual(blockIdOf("a b c"), blockIdOf("a b d"));
});

test("anchorAt records the block id, ordinal, exact quote, and capped preview", () => {
  const document = documentOf(original);
  const [, introOffset, tableOffset] = offsets(document);
  assert.ok(introOffset !== undefined && tableOffset !== undefined);
  const anchor = anchorAt(document, introOffset, "78% of the noise");
  assert.equal(anchor.index, 1);
  assert.equal(anchor.quote, "78% of the noise");
  assert.equal(anchor.preview, intro);
  const whole = anchorAt(document, tableOffset, "not in the block");
  assert.equal(whole.quote, null);
  assert.ok(whole.preview.startsWith("Table Suite | Fail rate"));
  const long = documentOf(`${"x".repeat(300)}\n`);
  assert.equal(anchorAt(long, 0, null).preview.length, 240);
  assert.throws(() => anchorAt(document, 7, null), /no block starts at offset 7/);
});

test("placeThreads anchors an unchanged block with no edit flag", () => {
  const document = documentOf(original);
  const introOffset = offsets(document)[1] ?? -1;
  const thread = threadAt(document, introOffset, "78% of the noise");
  const placement = placeThreads(document, [thread]);
  assert.deepEqual(placement.detached, []);
  const placed = placement.byOffset.get(introOffset)?.[0];
  assert.deepEqual(placed?.match, {
    kind: "anchored",
    offset: introOffset,
    index: 1,
    editedSince: false,
  });
  assert.equal(placed?.context, `markdown "${intro.slice(0, 57)}..."`);
});

test("placeThreads follows a block that moved to another index", () => {
  const document = documentOf(original);
  const thread = threadAt(document, offsets(document)[2] ?? -1, "22%");
  const moved = documentOf(`# Title\n\n${table}\n\n${intro}\n\n## The fix\n`);
  const placement = placeThreads(moved, [thread]);
  const [entry] = [...placement.byOffset.entries()];
  assert.ok(entry);
  const [offset, list] = entry;
  assert.equal(offset, offsets(moved)[1]);
  assert.deepEqual(list[0]?.match, { kind: "anchored", offset, index: 1, editedSince: false });
  assert.equal(list[0]?.context, 'Table "Top offenders"');
});

test("placeThreads finds the quote in an edited block and flags it", () => {
  const document = documentOf(original);
  const thread = threadAt(document, offsets(document)[1] ?? -1, "78% of the noise");
  const edited = documentOf(
    `# Title\n\nOnly three suites account for 78% of the noise, all on the shared port.\n\n${table}\n`,
  );
  const placement = placeThreads(edited, [thread]);
  const placed = placement.byOffset.get(offsets(edited)[1] ?? -1)?.[0];
  assert.equal(placed?.match.kind, "anchored");
  if (placed?.match.kind === "anchored") assert.equal(placed.match.editedSince, true);
});

test("placeThreads flags a matched block whose quote was edited away", () => {
  const document = documentOf(original);
  const thread = threadAt(document, offsets(document)[1] ?? -1, "78% of the noise");
  const rewritten: CommentThread = {
    ...thread,
    anchor: { ...thread.anchor, quote: "gone from the text" },
  };
  const placed = placeThreads(document, [rewritten]).byOffset.get(offsets(document)[1] ?? -1)?.[0];
  assert.equal(placed?.match.kind, "anchored");
  if (placed?.match.kind === "anchored") assert.equal(placed.match.editedSince, true);
});

test("placeThreads falls back to a fuzzy match on a lightly edited whole-block comment", () => {
  const document = documentOf(original);
  const thread = threadAt(document, offsets(document)[1] ?? -1, null);
  const edited = documentOf(
    `# Title\n\nFourteen suites failed at least once in the last 200 runs. Three of them account for 81% of the noise.\n`,
  );
  const placed = placeThreads(edited, [thread]).byOffset.get(offsets(edited)[1] ?? -1)?.[0];
  assert.equal(placed?.match.kind, "anchored");
  if (placed?.match.kind === "anchored") assert.equal(placed.match.editedSince, true);
  assert.ok(diceSimilarity(intro, "completely different words here") < 0.6);
});

test("placeThreads detaches a thread whose block is gone and keeps every thread exactly once", () => {
  const document = documentOf(original);
  const gone = threadAt(document, offsets(document)[1] ?? -1, "78% of the noise");
  const kept = { ...threadAt(document, offsets(document)[2] ?? -1, null), id: "cmt_klmnopqrst" };
  const rewritten = documentOf(
    `# Title\n\n${table}\n\nA new closing paragraph about something else.\n`,
  );
  const placement = placeThreads(rewritten, [gone, kept]);
  assert.deepEqual(
    placement.detached.map((placed) => [placed.thread.id, placed.match, placed.context]),
    [["cmt_abcdefghij", { kind: "detached" }, intro]],
  );
  const anchored = [...placement.byOffset.values()].flat();
  assert.deepEqual(
    anchored.map((placed) => placed.thread.id),
    ["cmt_klmnopqrst"],
  );
});
