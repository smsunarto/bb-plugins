import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UnknownCheckpointError,
  mintProviderThreadId,
  openThreadContinuity,
  type LedgerTurn,
} from "../src/bridge/continuity.ts";

const roots: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nanocodex-continuity-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function committed(ordinal: number, overrides: Partial<LedgerTurn> = {}): LedgerTurn {
  return {
    ordinal,
    requestId: `req-${ordinal}`,
    status: "completed",
    userText: `ask ${ordinal}`,
    commentary: [],
    final: `answer ${ordinal}`,
    actions: [],
    promptBytes: 40,
    firstCallInputTokens: null,
    ...overrides,
  };
}

test("mintProviderThreadId is deterministic and prefixed", () => {
  const id = mintProviderThreadId("thr_1");
  assert.equal(id, mintProviderThreadId("thr_1"));
  assert.notEqual(id, mintProviderThreadId("thr_2"));
  assert.match(id, /^nanocodex-[0-9a-f]{24}$/);
});

test("a missing ledger opens empty and never throws", () => {
  const continuity = openThreadContinuity({
    dataDir: makeDataDir(),
    providerThreadId: mintProviderThreadId("thr_missing"),
  });
  const state = continuity.peek();
  assert.equal(state.turns.length, 0);
  assert.equal(state.baseSummary, null);
  assert.equal(continuity.nextOrdinal, 0);
});

test("a committed turn survives reopen and advances the ordinal", () => {
  const dataDir = makeDataDir();
  const providerThreadId = mintProviderThreadId("thr_roundtrip");
  const first = openThreadContinuity({ dataDir, providerThreadId });
  first.beginTurn({ ordinal: 0, userText: "ask 0" });
  first.commitTurn(committed(0));

  const reopened = openThreadContinuity({ dataDir, providerThreadId });
  assert.equal(reopened.nextOrdinal, 1);
  assert.deepEqual(
    reopened.peek().turns.map((turn) => [turn.ordinal, turn.status, turn.final]),
    [[0, "completed", "answer 0"]],
  );
});

test("a pending with no turn folds as an interrupted turn: the crashed input survives", () => {
  const dataDir = makeDataDir();
  const providerThreadId = mintProviderThreadId("thr_crash");
  const before = openThreadContinuity({ dataDir, providerThreadId });
  before.beginTurn({ ordinal: 0, userText: "please do the thing" });

  const after = openThreadContinuity({ dataDir, providerThreadId });
  const state = after.peek();
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0]!.status, "interrupted");
  assert.equal(state.turns[0]!.userText, "please do the thing");
  assert.equal(state.turns[0]!.final, "");
  assert.equal(after.nextOrdinal, 1);
});

test("commitTurn is idempotent by ordinal: the last write wins in the fold", () => {
  const dataDir = makeDataDir();
  const providerThreadId = mintProviderThreadId("thr_replace");
  const continuity = openThreadContinuity({ dataDir, providerThreadId });
  continuity.commitTurn(committed(0, { final: "first attempt" }));
  continuity.commitTurn(committed(0, { final: "second attempt" }));

  const reopened = openThreadContinuity({ dataDir, providerThreadId });
  assert.equal(reopened.peek().turns.length, 1);
  assert.equal(reopened.peek().turns[0]!.final, "second attempt");
  assert.equal(reopened.nextOrdinal, 1);
});

test("a torn trailing line self-heals: earlier records still fold", () => {
  const dataDir = makeDataDir();
  const providerThreadId = mintProviderThreadId("thr_torn");
  const continuity = openThreadContinuity({ dataDir, providerThreadId });
  continuity.commitTurn(committed(0));
  const dir = join(dataDir, "threads");
  const file = join(dir, readdirSync(dir)[0]!);
  appendFileSync(file, '{"v":1,"kind":"turn","turn":{"ordinal":1,"stat');

  const reopened = openThreadContinuity({ dataDir, providerThreadId });
  assert.equal(reopened.peek().turns.length, 1);
  assert.equal(reopened.nextOrdinal, 1);
});

test("compaction shadows turns at or below throughOrdinal and renders as the base summary", () => {
  const dataDir = makeDataDir();
  const providerThreadId = mintProviderThreadId("thr_compact");
  const continuity = openThreadContinuity({ dataDir, providerThreadId });
  for (const n of [0, 1, 2]) continuity.commitTurn(committed(n));
  continuity.commitCompaction({ throughOrdinal: 1, summary: "did the early work" });

  const reopened = openThreadContinuity({ dataDir, providerThreadId });
  const state = reopened.peek();
  assert.equal(state.baseSummary, "did the early work");
  assert.equal(state.baseThrough, 1);
  assert.deepEqual(
    state.turns.map((turn) => turn.ordinal),
    [2],
  );
  assert.equal(reopened.nextOrdinal, 3);
  const composed = reopened.composePrompt({
    input: [{ type: "text", text: "next", mentions: [] }],
    instructions: null,
    instructionMode: "append",
    budgetBytes: 60_000,
  });
  assert.ok(composed.text.includes("[summary of 2 earlier turns: did the early work]"));
});

test("calibration folds as a max and never decreases", () => {
  const dataDir = makeDataDir();
  const providerThreadId = mintProviderThreadId("thr_calibrate");
  const continuity = openThreadContinuity({ dataDir, providerThreadId });
  continuity.commitTurn(committed(0, { promptBytes: 400, firstCallInputTokens: 20_000 }));
  const high = continuity.peek().observedFixedTokens;
  assert.equal(high, 20_000 - 100);
  continuity.commitTurn(committed(1, { promptBytes: 400, firstCallInputTokens: 14_000 }));
  assert.equal(continuity.peek().observedFixedTokens, high);

  const reopened = openThreadContinuity({ dataDir, providerThreadId });
  assert.equal(reopened.peek().observedFixedTokens, high);
});

test("composePrompt routes instructions by mode", () => {
  const continuity = openThreadContinuity({
    dataDir: makeDataDir(),
    providerThreadId: mintProviderThreadId("thr_instructions"),
  });
  const replace = continuity.composePrompt({
    input: [{ type: "text", text: "go", mentions: [] }],
    instructions: "be terse",
    instructionMode: "replace",
    budgetBytes: 60_000,
  });
  assert.equal(replace.instructionsFlag, "be terse");
  assert.equal(replace.text, "go");

  const append = continuity.composePrompt({
    input: [{ type: "text", text: "go", mentions: [] }],
    instructions: "be terse",
    instructionMode: "append",
    budgetBytes: 60_000,
  });
  assert.equal(append.instructionsFlag, null);
  assert.equal(append.text, "be terse\n\ngo");
});

test("forkInto at the tip copies the fold into a new thread's ledger", () => {
  const dataDir = makeDataDir();
  const source = openThreadContinuity({
    dataDir,
    providerThreadId: mintProviderThreadId("thr_fork_src"),
  });
  for (const n of [0, 1]) source.commitTurn(committed(n));

  const fork = source.forkInto({ threadId: "thr_fork_dst", throughOrdinal: null });
  assert.equal(fork.providerThreadId, mintProviderThreadId("thr_fork_dst"));
  assert.deepEqual(
    fork.peek().turns.map((turn) => turn.ordinal),
    [0, 1],
  );

  const reopened = openThreadContinuity({
    dataDir,
    providerThreadId: mintProviderThreadId("thr_fork_dst"),
  });
  assert.deepEqual(
    reopened.peek().turns.map((turn) => turn.ordinal),
    [0, 1],
  );
});

test("forkInto slices at a checkpoint, and a pre-compaction checkpoint reads the full history", () => {
  const dataDir = makeDataDir();
  const source = openThreadContinuity({
    dataDir,
    providerThreadId: mintProviderThreadId("thr_fork_slice"),
  });
  for (const n of [0, 1, 2]) source.commitTurn(committed(n));
  source.commitCompaction({ throughOrdinal: 2, summary: "all of it" });

  const fork = source.forkInto({ threadId: "thr_fork_pre", throughOrdinal: 1 });
  const state = fork.peek();
  assert.equal(state.baseSummary, null);
  assert.deepEqual(
    state.turns.map((turn) => turn.ordinal),
    [0, 1],
  );
  assert.equal(fork.nextOrdinal, 2);
});

test("forkInto rejects a checkpoint this thread never had", () => {
  const source = openThreadContinuity({
    dataDir: makeDataDir(),
    providerThreadId: mintProviderThreadId("thr_fork_bad"),
  });
  source.commitTurn(committed(0));
  assert.throws(
    () => source.forkInto({ threadId: "thr_x", throughOrdinal: 99 }),
    UnknownCheckpointError,
  );
  assert.throws(
    () => source.forkInto({ threadId: "thr_x", throughOrdinal: -1 }),
    UnknownCheckpointError,
  );
});

test("discard deletes the ledger and is idempotent", () => {
  const dataDir = makeDataDir();
  const providerThreadId = mintProviderThreadId("thr_discard");
  const continuity = openThreadContinuity({ dataDir, providerThreadId });
  continuity.commitTurn(committed(0));
  continuity.discard();
  continuity.discard();
  assert.equal(continuity.peek().turns.length, 0);

  const reopened = openThreadContinuity({ dataDir, providerThreadId });
  assert.equal(reopened.peek().turns.length, 0);
});
