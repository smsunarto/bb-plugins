/**
 * `src/bridge/continuity.ts` — the answer to "nanocodex run is one-shot".
 *
 * Every `nanocodex run` is a fresh session. `resume` is TUI-only and
 * `config.build()` always passes `session_id: None, snapshot: None`, so no
 * headless path exists that consumes a prior session. bb threads are
 * multi-turn and outlive the daemon. The bridge therefore carries the
 * conversation itself, and this module is the whole of that carrying.
 *
 * ONE data structure — a per-thread append-only ledger — answers four
 * questions the rest of the bridge never has to think about:
 *
 *   continuity   `composePrompt` renders history + new input into the single
 *                positional argument `nanocodex run` accepts.
 *   resume       `open()` folds the file. A bridge restart costs one read.
 *   fork         `forkInto` copies the fold up to an ordinal.
 *   compaction   `commitCompaction` appends a record that shadows earlier ones.
 *
 * Depth check: callers see six methods and never see `LedgerEvent`, the file
 * format, the budget policy, or the rendered layout. `session.ts` calls
 * `composePrompt` and `commitTurn` and knows nothing else about continuity.
 * Per boundary-discipline, the transport-ish `PromptInput[]` is parsed into
 * plain text at this boundary and never stored on the wire shape.
 *
 * Ownership: exactly one `ThreadContinuity` instance exists per bb thread,
 * held by that thread's session, and it is the only writer of its file. Two
 * actors never write the same ledger, so nothing here locks — per
 * separate-before-serializing-shared-state, the state is partitioned rather
 * than shared. A fork READS a source file and WRITES a different one.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { byteLength, flattenPromptInput, renderPrompt } from "./prompt.ts";

// ---------------------------------------------------------------------------
// The persisted vocabulary (private to this module)
// ---------------------------------------------------------------------------

/**
 * One settled turn, as history. Tiered on purpose: `prompt.ts` degrades a turn
 * from full to summary to elided as the budget tightens, so the tiers have to
 * be separable fields rather than one pre-rendered blob.
 *
 * `commentary` and `final` are both real assistant prose in nanocodex
 * (`assistant.message` carries `phase: "commentary" | "final_answer"`), and
 * commentary is often the most useful continuity signal ("I'll create
 * hello.txt, then read it back"). It is dropped one tier before the final
 * answer, not first.
 */
export interface LedgerTurn {
  /** Dense from 0, gap-free, and the fork checkpoint id. */
  readonly ordinal: number;
  /** nanocodex's session uuid for the run that produced this turn (`request_id`). Null when the child died before `run.started`. */
  readonly requestId: string | null;
  readonly status: "completed" | "failed" | "interrupted";
  /** The user's text for this turn, already flattened from `PromptInput[]`. */
  readonly userText: string;
  readonly commentary: readonly string[];
  readonly final: string;
  /** What the turn DID, for a model that must not redo finished work. Bounded at write time. */
  readonly actions: readonly TurnAction[];
  /** Rendered prompt size in bytes, and what nanocodex charged for it. Feeds the budget's calibration. */
  readonly promptBytes: number;
  /** `usage.input_tokens` of the first `model.call.completed`: instructions + tools + our prompt, measured. Null when the call never completed. */
  readonly firstCallInputTokens: number | null;
}

export type TurnAction =
  | { kind: "command"; command: string; exitCode: number | null }
  | { kind: "fileChange"; paths: readonly string[] }
  | { kind: "tool"; tool: string; brief: string };

/**
 * The folded view a render sees. `baseSummary` is the compaction result that
 * stands in for every turn at or below `baseThrough`.
 */
export interface ContinuityState {
  readonly baseSummary: string | null;
  readonly baseThrough: number | null;
  /** Turns above `baseThrough`, ascending. */
  readonly turns: readonly LedgerTurn[];
  readonly nextOrdinal: number;
  /** Measured overhead, used to shrink the byte budget when nanocodex charges more than assumed. Monotonically non-decreasing. */
  readonly observedFixedTokens: number | null;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/** What `run.ts` needs to invoke nanocodex for one turn. */
export interface ComposedPrompt {
  /** The single positional argument for `nanocodex run`. Never empty. */
  readonly text: string;
  /**
   * The `--instructions` value, or null to omit the flag.
   *
   * `--instructions` REPLACES nanocodex's system prompt; there is no append
   * flag. So `instructionMode: "replace"` becomes the flag, and
   * `instructionMode: "append"` folds the instructions into `text` instead.
   * Which one happened is decided here, beside the text it affects, and the
   * caller only forwards the answer.
   */
  readonly instructionsFlag: string | null;
  /** `text.length` in bytes. Recorded on the turn so the next budget can calibrate. */
  readonly bytes: number;
  /** How many historical turns the budget dropped. Surfaced as a `provider.warning` when it first becomes non-zero. */
  readonly elidedTurns: number;
}

export interface ComposePromptArgs {
  readonly input: readonly PromptInput[];
  /** `options.instructions` for this turn, re-sent every turn because every run is a fresh session. */
  readonly instructions: string | null;
  readonly instructionMode: "append" | "replace";
  /** From the `historyBudgetKb` plugin setting, via providerOptions. */
  readonly budgetBytes: number;
}

export interface ThreadContinuity {
  readonly providerThreadId: string;

  /** The ordinal the next turn will occupy. Read before the turn runs, so the scribe can stamp its boundary. */
  readonly nextOrdinal: number;

  /**
   * Render the prompt for one turn. Pure with respect to the ledger: the same
   * ledger and the same arguments always produce the same bytes, with no clock
   * and no entropy, because the prompt lands in the child's argv and the
   * parity oracle must reproduce it exactly.
   */
  composePrompt(args: ComposePromptArgs): ComposedPrompt;

  /**
   * Write-ahead record, appended BEFORE the child spawns: `{kind: "pending",
   * ordinal, userText}`. `commitTurn` for the same ordinal shadows it in the
   * fold. A pending left behind by a crash folds as an interrupted `LedgerTurn`
   * with empty output, so the user's text for a crashed turn survives into the
   * next prompt instead of vanishing. Idempotent by ordinal like everything
   * else in the file.
   */
  beginTurn(args: { ordinal: number; userText: string }): void;

  /**
   * Record a settled turn. Append-only and idempotent by ordinal: a second
   * append for the same ordinal replaces the first in the fold, so a crash
   * between the child's terminal event and this call loses at most that turn's
   * OUTPUT (the pending record keeps its input), and a retry of that same turn
   * never duplicates it.
   */
  commitTurn(turn: LedgerTurn): void;

  /**
   * Replace history up to `throughOrdinal` with one summary. Appends a record
   * rather than rewriting the file, so it is crash-safe for free and a fork
   * taken before the compaction still reads the full history.
   */
  commitCompaction(args: { throughOrdinal: number; summary: string }): void;

  /**
   * Copy this thread's history into a new bb thread. `throughOrdinal: null`
   * copies to the tip (`fork: "tip"`); a number slices (`fork: "checkpoint"`).
   * Throws `UnknownCheckpointError` for an ordinal this thread never had, which
   * `entry.ts` answers as FORK_CHECKPOINT_UNSUPPORTED (-32003).
   */
  forkInto(args: { threadId: string; throughOrdinal: number | null }): ThreadContinuity;

  /** Delete the file. `thread/discard`. Idempotent. */
  discard(): void;

  /** For `provider.warning` copy and for tests. Never rendered directly. */
  peek(): ContinuityState;
}

export class UnknownCheckpointError extends Error {}

/**
 * Deterministic provider thread id: `nanocodex-${sha256(bbThreadId)[0..24]}`.
 *
 * Deterministic on purpose. `thread/resume` arrives after every daemon restart
 * AND routinely — declaring `sessionRestorable: true` turns on the runtime's
 * idle-session reaping, so resume is a hot path, not an emergency. Because the
 * id is re-derivable, resume can always find its own ledger, and a resume for
 * an id this bridge would have minted is always answerable.
 */
export function mintProviderThreadId(bbThreadId: string): string {
  return `nanocodex-${createHash("sha256").update(bbThreadId).digest("hex").slice(0, 24)}`;
}

/**
 * The measured fixed cost of a bare run (instructions + tool schemas): the
 * `hello` fixture charges 13,466 input tokens for a 5-byte prompt. The budget
 * only shrinks when a turn measures MORE overhead than this.
 */
const ASSUMED_FIXED_TOKENS = 13_400;

/** The budget never calibrates below this; pinned + recent must stay renderable. */
const MIN_BUDGET_BYTES = 8_192;

/** ~4 bytes of prompt per token; used only to convert calibration excess. */
const BYTES_PER_TOKEN = 4;

const LEDGER_VERSION = 1;

interface PendingRecord {
  readonly ordinal: number;
  readonly userText: string;
}

interface Fold {
  baseSummary: string | null;
  baseThrough: number | null;
  turnsByOrdinal: Map<number, LedgerTurn>;
  pendingByOrdinal: Map<number, PendingRecord>;
  observedFixedTokens: number | null;
  /** Highest ordinal any record ever named, compaction shadowing included. */
  maxSeenOrdinal: number | null;
}

function emptyFold(): Fold {
  return {
    baseSummary: null,
    baseThrough: null,
    turnsByOrdinal: new Map(),
    pendingByOrdinal: new Map(),
    observedFixedTokens: null,
    maxSeenOrdinal: null,
  };
}

function seeOrdinal(fold: Fold, ordinal: number): void {
  fold.maxSeenOrdinal =
    fold.maxSeenOrdinal === null ? ordinal : Math.max(fold.maxSeenOrdinal, ordinal);
}

function isLedgerTurn(value: unknown): value is LedgerTurn {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ordinal === "number" &&
    (record.status === "completed" || record.status === "failed" || record.status === "interrupted") &&
    typeof record.userText === "string" &&
    typeof record.final === "string" &&
    Array.isArray(record.commentary) &&
    Array.isArray(record.actions)
  );
}

/**
 * Fold parsed ledger lines. `through` slices for a fork: records above it are
 * skipped, and a compaction summarizing PAST the slice is skipped too — the
 * fork predates that compaction, so it reads the full per-turn history the
 * append-only file still holds.
 */
function applyLine(fold: Fold, line: unknown, through: number | null): void {
  if (typeof line !== "object" || line === null) return;
  const record = line as Record<string, unknown>;
  if (record.v !== LEDGER_VERSION || typeof record.kind !== "string") return;
  switch (record.kind) {
    case "pending": {
      if (typeof record.ordinal !== "number" || typeof record.userText !== "string") return;
      seeOrdinal(fold, record.ordinal);
      if (through !== null && record.ordinal > through) return;
      fold.pendingByOrdinal.set(record.ordinal, {
        ordinal: record.ordinal,
        userText: record.userText,
      });
      return;
    }
    case "turn": {
      if (!isLedgerTurn(record.turn)) return;
      const turn = record.turn;
      seeOrdinal(fold, turn.ordinal);
      if (through !== null && turn.ordinal > through) return;
      fold.turnsByOrdinal.set(turn.ordinal, turn);
      return;
    }
    case "compaction": {
      if (typeof record.throughOrdinal !== "number" || typeof record.summary !== "string") return;
      seeOrdinal(fold, record.throughOrdinal);
      if (through !== null && record.throughOrdinal > through) return;
      fold.baseSummary = record.summary;
      fold.baseThrough = record.throughOrdinal;
      for (const ordinal of [...fold.turnsByOrdinal.keys()]) {
        if (ordinal <= record.throughOrdinal) fold.turnsByOrdinal.delete(ordinal);
      }
      for (const ordinal of [...fold.pendingByOrdinal.keys()]) {
        if (ordinal <= record.throughOrdinal) fold.pendingByOrdinal.delete(ordinal);
      }
      return;
    }
    case "calibration": {
      if (typeof record.tokens !== "number") return;
      fold.observedFixedTokens =
        fold.observedFixedTokens === null
          ? record.tokens
          : Math.max(fold.observedFixedTokens, record.tokens);
      return;
    }
    default:
      return;
  }
}

function foldLines(raw: string, through: number | null): Fold {
  const fold = emptyFold();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn trailing write self-heals by being dropped; a torn line in the
      // middle (never observed with O_APPEND) drops the same way.
      continue;
    }
    applyLine(fold, parsed, through);
  }
  return fold;
}

function interruptedFromPending(pending: PendingRecord): LedgerTurn {
  return {
    ordinal: pending.ordinal,
    requestId: null,
    status: "interrupted",
    userText: pending.userText,
    commentary: [],
    final: "",
    actions: [],
    promptBytes: 0,
    firstCallInputTokens: null,
  };
}

function stateOf(fold: Fold): ContinuityState {
  const byOrdinal = new Map(fold.turnsByOrdinal);
  for (const pending of fold.pendingByOrdinal.values()) {
    if (!byOrdinal.has(pending.ordinal)) {
      byOrdinal.set(pending.ordinal, interruptedFromPending(pending));
    }
  }
  const turns = [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  const nextOrdinal =
    fold.maxSeenOrdinal !== null ? fold.maxSeenOrdinal + 1 : (fold.baseThrough ?? -1) + 1;
  return {
    baseSummary: fold.baseSummary,
    baseThrough: fold.baseThrough,
    turns,
    nextOrdinal,
    observedFixedTokens: fold.observedFixedTokens,
  };
}

function ledgerPathFor(dataDir: string, providerThreadId: string): string {
  const name = createHash("sha256").update(providerThreadId).digest("hex");
  return join(dataDir, "threads", `${name}.jsonl`);
}

/**
 * Open (or create) the ledger for one thread.
 *
 * TOTAL BY DESIGN. It never throws for a missing, empty, truncated, or foreign
 * ledger — a thread with no history opens with no history. This is the whole
 * reason `thread/resume` in `entry.ts` has no error path: a bridge error on
 * resume fails the turn submission outright and the daemon has NO fresh-start
 * fallback (verified in apps/host-daemon/src/command-handlers/thread.ts —
 * `resumeThreadRuntimeIfMissing` propagates), so an amnesiac thread is strictly
 * better than a bricked one. When history was expected and is absent,
 * `session.ts` says so with a `provider.warning`; it does not fail.
 *
 * File: `<dataDir>/threads/<sha256(providerThreadId)>.jsonl`, one JSON object
 * per line, appended with `O_APPEND`. Reading folds the lines and DISCARDS an
 * unparseable trailing line, so a torn write self-heals instead of corrupting.
 */
export function openThreadContinuity(args: {
  dataDir: string;
  providerThreadId: string;
}): ThreadContinuity {
  const { dataDir, providerThreadId } = args;
  const path = ledgerPathFor(dataDir, providerThreadId);

  let fold: Fold;
  try {
    fold = foldLines(readFileSync(path, "utf8"), null);
  } catch {
    fold = emptyFold();
  }

  const append = (record: Record<string, unknown>): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ v: LEDGER_VERSION, ...record })}\n`, {
        flag: "a",
      });
    } catch {
      // A read-only disk costs durability for this record, not the turn: the
      // in-memory fold stays authoritative for this session's lifetime.
    }
  };

  const continuity: ThreadContinuity = {
    providerThreadId,
    get nextOrdinal() {
      return stateOf(fold).nextOrdinal;
    },
    composePrompt({ input, instructions, instructionMode, budgetBytes }) {
      const state = stateOf(fold);
      const excessTokens = Math.max(
        0,
        (state.observedFixedTokens ?? 0) - ASSUMED_FIXED_TOKENS,
      );
      const effectiveBudget = Math.max(
        MIN_BUDGET_BYTES,
        budgetBytes - excessTokens * BYTES_PER_TOKEN,
      );
      const flattened = flattenPromptInput(input);
      const userText = flattened.length > 0 ? flattened : "(empty request)";
      const rendered = renderPrompt({ state, userText, budgetBytes: effectiveBudget });
      const withInstructions =
        instructionMode === "append" && instructions !== null && instructions.length > 0
          ? `${instructions}\n\n${rendered.text}`
          : rendered.text;
      const instructionsFlag =
        instructionMode === "replace" && instructions !== null && instructions.length > 0
          ? instructions
          : null;
      return {
        text: withInstructions,
        instructionsFlag,
        bytes: byteLength(withInstructions),
        elidedTurns: rendered.elidedTurns,
      };
    },
    beginTurn({ ordinal, userText }) {
      append({ kind: "pending", ordinal, userText });
      fold.pendingByOrdinal.set(ordinal, { ordinal, userText });
      seeOrdinal(fold, ordinal);
    },
    commitTurn(turn) {
      append({ kind: "turn", turn });
      fold.turnsByOrdinal.set(turn.ordinal, turn);
      seeOrdinal(fold, turn.ordinal);
      if (turn.firstCallInputTokens !== null && turn.promptBytes > 0) {
        const measured = Math.max(
          0,
          turn.firstCallInputTokens - Math.ceil(turn.promptBytes / BYTES_PER_TOKEN),
        );
        if (measured > (fold.observedFixedTokens ?? -1)) {
          append({ kind: "calibration", tokens: measured });
          fold.observedFixedTokens = measured;
        }
      }
    },
    commitCompaction({ throughOrdinal, summary }) {
      append({ kind: "compaction", throughOrdinal, summary });
      applyLine(fold, { v: LEDGER_VERSION, kind: "compaction", throughOrdinal, summary }, null);
    },
    forkInto({ threadId, throughOrdinal }) {
      if (throughOrdinal !== null) {
        const known =
          Number.isInteger(throughOrdinal) &&
          throughOrdinal >= 0 &&
          fold.maxSeenOrdinal !== null &&
          throughOrdinal <= fold.maxSeenOrdinal;
        if (!known) {
          throw new UnknownCheckpointError(
            `thread ${providerThreadId} has no checkpoint ${String(throughOrdinal)}`,
          );
        }
      }
      let sliced: Fold;
      try {
        sliced = foldLines(readFileSync(path, "utf8"), throughOrdinal);
      } catch {
        sliced = emptyFold();
      }
      const state = stateOf(sliced);
      const forkedProviderThreadId = mintProviderThreadId(threadId);
      const forkedPath = ledgerPathFor(dataDir, forkedProviderThreadId);
      const records: Record<string, unknown>[] = [];
      if (state.baseSummary !== null) {
        records.push({
          v: LEDGER_VERSION,
          kind: "compaction",
          throughOrdinal: state.baseThrough,
          summary: state.baseSummary,
        });
      }
      for (const turn of state.turns) records.push({ v: LEDGER_VERSION, kind: "turn", turn });
      if (state.observedFixedTokens !== null) {
        records.push({ v: LEDGER_VERSION, kind: "calibration", tokens: state.observedFixedTokens });
      }
      try {
        mkdirSync(dirname(forkedPath), { recursive: true });
        writeFileSync(
          forkedPath,
          records.map((record) => `${JSON.stringify(record)}\n`).join(""),
        );
      } catch {
        // The fork still opens; it is merely amnesiac, like any missing ledger.
      }
      return openThreadContinuity({ dataDir, providerThreadId: forkedProviderThreadId });
    },
    discard() {
      try {
        rmSync(path, { force: true });
      } catch {
        // Idempotent: a file already gone is the desired end state.
      }
      fold = emptyFold();
    },
    peek() {
      return stateOf(fold);
    },
  };
  return continuity;
}
