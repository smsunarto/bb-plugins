import assert from "node:assert/strict";
import { test } from "bun:test";
import type { LedgerTurn } from "../src/bridge/continuity.ts";
import {
  byteLength,
  flattenPromptInput,
  planTiers,
  renderPrompt,
} from "../src/bridge/prompt.ts";

function turn(ordinal: number, overrides: Partial<LedgerTurn> = {}): LedgerTurn {
  return {
    ordinal,
    requestId: `req-${ordinal}`,
    status: "completed",
    userText: `user text for turn ${ordinal}`,
    commentary: [`commentary for turn ${ordinal}`],
    final: `final answer for turn ${ordinal}`,
    actions: [
      { kind: "command", command: `echo ${ordinal}`, exitCode: 0 },
      { kind: "fileChange", paths: [`file-${ordinal}.txt`] },
    ],
    promptBytes: 100,
    firstCallInputTokens: null,
    ...overrides,
  };
}

function emptyState() {
  return {
    baseSummary: null,
    baseThrough: null,
    turns: [] as LedgerTurn[],
    nextOrdinal: 0,
    observedFixedTokens: null,
  };
}

test("byteLength counts UTF-8 bytes, not UTF-16 units", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2);
  assert.equal(byteLength("🙂"), 4);
});

test("a first turn pays nothing: no history renders the user text verbatim", () => {
  const rendered = renderPrompt({ state: emptyState(), userText: "hello", budgetBytes: 60_000 });
  assert.equal(rendered.text, "hello");
  assert.equal(rendered.bytes, 5);
  assert.equal(rendered.elidedTurns, 0);
});

test("planTiers keeps everything full under a generous budget", () => {
  const turns = [0, 1, 2, 3].map((n) => turn(n));
  const tiers = planTiers(turns, 60_000);
  for (const t of turns) assert.equal(tiers.get(t.ordinal), "full");
});

test("planTiers pins the first turn and keeps the recent two full when the budget is tight", () => {
  const turns = [0, 1, 2, 3, 4, 5].map((n) => turn(n));
  const tight = turns.reduce(
    (bytes, t) => bytes + byteLength(t.userText) + byteLength(t.final),
    0,
  );
  const tiers = planTiers(turns, tight);
  assert.equal(tiers.get(4), "full");
  assert.equal(tiers.get(5), "full");
  assert.notEqual(tiers.get(0), "elided");
  assert.equal(tiers.get(1), "elided");
  assert.equal(tiers.get(2), "elided");
});

test("a larger budget never keeps fewer turns", () => {
  const turns = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => turn(n));
  let previousKept = -1;
  for (const budget of [200, 800, 3_000, 20_000, 60_000]) {
    const tiers = planTiers(turns, budget);
    const kept = turns.filter((t) => tiers.get(t.ordinal) !== "elided").length;
    assert.ok(kept >= previousKept, `budget ${budget} kept ${kept} < ${previousKept}`);
    previousKept = kept;
  }
});

test("renderPrompt collapses an elided run into one marker and tags the layout", () => {
  const turns = [0, 1, 2, 3, 4, 5].map((n) => turn(n));
  const tiers = planTiers(turns, 500);
  const elided = turns.filter((t) => tiers.get(t.ordinal) === "elided").length;
  assert.ok(elided >= 2, "the fixture budget must elide a run");
  const rendered = renderPrompt({
    state: { ...emptyState(), turns, nextOrdinal: 6 },
    userText: "what next?",
    budgetBytes: 500,
  });
  assert.equal(rendered.elidedTurns, elided);
  assert.ok(rendered.text.includes(`[${elided} earlier exchanges omitted]`));
  assert.equal(rendered.text.match(/earlier exchanges omitted/g)?.length, 1);
  assert.ok(rendered.text.startsWith("<bb-thread-history>"));
  assert.ok(rendered.text.endsWith("<bb-request>\nwhat next?\n</bb-request>"));
  assert.ok(rendered.text.includes("## Turn 5 - user"));
  assert.ok(rendered.text.includes("### Turn 5 - actions"));
  assert.ok(rendered.text.includes("- $ echo 5 (exit 0)"));
  assert.ok(rendered.text.includes("- edited file-5.txt"));
});

test("the base summary renders ahead of the surviving turns", () => {
  const rendered = renderPrompt({
    state: {
      baseSummary: "we built hello.txt and verified it",
      baseThrough: 3,
      turns: [turn(4)],
      nextOrdinal: 5,
      observedFixedTokens: null,
    },
    userText: "continue",
    budgetBytes: 60_000,
  });
  assert.ok(
    rendered.text.includes("[summary of 4 earlier turns: we built hello.txt and verified it]"),
  );
  assert.ok(rendered.text.indexOf("summary of 4") < rendered.text.indexOf("## Turn 4 - user"));
});

test("an overlong single text truncates in the middle, keeping head and tail", () => {
  const long = `INTENT ${"x".repeat(20_000)} OUTCOME`;
  const turns = [turn(0, { userText: long }), turn(1)];
  const rendered = renderPrompt({
    state: { ...emptyState(), turns, nextOrdinal: 2 },
    userText: "go",
    budgetBytes: 60_000,
  });
  assert.ok(rendered.text.includes("bytes omitted] ..."));
  assert.ok(rendered.text.includes("INTENT"));
  assert.ok(rendered.text.includes("OUTCOME"));
  assert.ok(rendered.bytes < 20_000);
});

test("pinned plus recent overflowing the budget tightens the cap instead of overflowing", () => {
  const huge = "y".repeat(30_000);
  const turns = [turn(0, { userText: huge, final: huge }), turn(1, { final: huge })];
  const rendered = renderPrompt({
    state: { ...emptyState(), turns, nextOrdinal: 2 },
    userText: "go",
    budgetBytes: 2_000,
  });
  assert.ok(rendered.bytes < 12_000, `rendered ${rendered.bytes} bytes`);
});

test("rendering is deterministic", () => {
  const state = { ...emptyState(), turns: [0, 1, 2].map((n) => turn(n)), nextOrdinal: 3 };
  const a = renderPrompt({ state, userText: "again", budgetBytes: 1_000 });
  const b = renderPrompt({ state, userText: "again", budgetBytes: 1_000 });
  assert.equal(a.text, b.text);
  assert.equal(a.bytes, b.bytes);
});

test("flattenPromptInput keeps text, maps files and images to mentions, includes agent-only", () => {
  const text = flattenPromptInput([
    { type: "text", text: "run the tests", mentions: [] },
    { type: "text", text: "(for the agent)", visibility: "agent-only", mentions: [] },
    { type: "localFile", path: "/repo/notes.md" },
    { type: "localImage", path: "/repo/shot.png" },
    { type: "image", url: "https://example.com/x.png" },
    { type: "mystery" },
  ]);
  assert.equal(
    text,
    [
      "run the tests",
      "(for the agent)",
      "(see the file at /repo/notes.md)",
      "(see the file at /repo/shot.png)",
      "(see the image at https://example.com/x.png)",
    ].join("\n\n"),
  );
});
