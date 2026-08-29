/**
 * `src/bridge/timeline.ts` — the ONE place that knows grammar-v3.
 *
 * Nothing outside this file constructs a `ThreadDelta`. Grep for
 * `kind: "item.` and it should only ever match here. `project.ts` calls
 * scribe methods; `session.ts` calls writer methods.
 *
 * Two writers, one file, because they are two halves of one policy — how this
 * plugin's deltas reach the wire:
 *
 *   ThreadWriter — session scope. Owns identity, the session boundary, the
 *                  running usage total, batching, and ordering.
 *   TurnScribe   — turn scope. Owns the text lanes, the open-item table, item
 *                  key namespacing, acceptance, and settlement.
 *
 * Three protocol invariants are enforced by construction rather than by
 * discipline, per encode-lessons-in-structure:
 *
 *  1. No delta can precede identity. There is no way to obtain a writer
 *     without `thread/identity` having gone out, and no way to emit a delta
 *     without a writer. (Gotcha 6, pre-identity buffering — the buffer does
 *     not exist because the window does not exist.)
 *  2. No item key can collide across turns. `ItemKey` is branded and only
 *     `TurnScribe.itemKey`/`mintKey` mint one, both prefixed with the turn's
 *     ordinal. The runtime assembler maps `providerItemId -> bbItemId` per
 *     THREAD and NEVER clears that map — not even on `session.reset`; it is
 *     only trimmed oldest-first at 1024 entries (verified in bb's
 *     delta-assembler.ts) — so a nanocodex id that repeats across turns
 *     (`model_call_index` restarts at 1 on every `run`) would silently alias
 *     two items and fail `session/resume-id-uniqueness`.
 *  3. Every dispatched `clientRequestId` settles. `settle()` accepts any
 *     un-accepted ids first, so a child that dies before `run.started` still
 *     produces `input.accepted` + `turn.open` + `turn.boundary`.
 *     (Gotchas 4, 5 and 7.)
 */

import {
  BRIDGE_NOTIFICATION_METHODS,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  type ClientTurnRequestId,
  type DeltaItemShape,
  type DeltaPresentation,
  type JsonValue,
  type ProviderErrorCategory,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
  type ThreadEventTurnStatus,
} from "@get-bb/plugin-sdk/provider-bridge";
import { NANOCODEX_CONTEXT_WINDOW_TOKENS } from "../catalog.ts";

// ---------------------------------------------------------------------------
// Values that pair "what it is" with "how it reads"
// ---------------------------------------------------------------------------

/**
 * A timeline row: the item shape and its presentation as one value. Grammar
 * v3 makes `presentation` optional for core shapes; pairing them here means
 * `shapes.ts` cannot name a row without saying how it renders.
 */
export interface TimelineRow {
  readonly item: DeltaItemShape;
  readonly presentation: DeltaPresentation;
}

/**
 * A turn-namespaced provider item key. Branded so `openItem` cannot be handed
 * a raw nanocodex id; see invariant 2 above.
 */
export type ItemKey = string & { readonly __brand: "NanocodexItemKey" };

/** A handle to an item this turn opened. Only `openItem` mints one. */
export interface OpenItem {
  readonly key: ItemKey;
}

/** How an item ended. `row` supplies the terminal shape when it differs from the opened one. */
export type ItemOutcome =
  | {
      status: "completed" | "failed";
      row?: TimelineRow;
      resultText?: string;
      aggregatedOutput?: string;
      exitCode?: number;
    }
  | { status: "interrupted"; row?: TimelineRow };

// ---------------------------------------------------------------------------
// ThreadWriter — session scope
// ---------------------------------------------------------------------------

export interface ThreadWriter {
  /** Append deltas. FIFO across every caller, batched per macrotask. */
  emit(deltas: readonly ThreadDelta[]): void;

  /** Put pending deltas on the wire now. `thread/stop` uses this to get a boundary out before its result. */
  flush(): void;

  /**
   * Add one usage reading and emit `usage` + `contextWindow`. The running
   * total lives here and nowhere else. `last` must already include warmup:
   * the terminal event reports `usage` and `warmup_usage` as SEPARATE flat
   * shapes, and the honest per-turn spend is their sum (fixture arithmetic:
   * 13,470 + 13,648 = 27,118 turn tokens, warmup 9,742 on top). The caller
   * sums via `addTokenUsage(usageBreakdown(usage), usageBreakdown(warmup_usage))`.
   */
  addUsage(last: ThreadEventTokenUsageBreakdown, promptTokens: number | null): void;

  /** `provider/recovery` — unsolicited hints only. A hint explaining a request failure rides that request's `error.data.recovery` instead; the two carriers are mutually exclusive. */
  recovery(hint: { kind: "authRequired" | "rateLimited" | "restartRecommended" | "sessionArchived" | "staleTurn"; message: string; retryable: boolean }): void;

  /** `provider/raw`. Droppable diagnostics; never blocks real deltas. Used for `unknown` event kinds only — `noise` is dropped without a notification. */
  raw(payload: JsonValue, coverage: "noise" | "unknown"): void;

  /** Start a scribe for one bb turn. `ordinal` is the ledger ordinal, which is also the fork checkpoint id. */
  scribe(args: { ordinal: number; clientRequestIds: readonly ClientTurnRequestId[] }): TurnScribe;
}

/**
 * Construct a thread writer. Emits `thread/identity` and then the
 * `session.reset` delta before returning, in that order.
 *
 * `session.reset` is unconditional: it is required at every session
 * construction, on `thread/start`, `thread/resume` and `thread/fork` alike
 * (Gotcha 3). It does NOT clear the runtime assembler's per-thread id map
 * (nothing does; see invariant 2 above), which is why the ordinal-prefixed
 * `ItemKey` carries the uniqueness burden, not the reset.
 *
 * `sessionRestorable` is a plain extra field on the identity notification and
 * on the start/resume/fork result. It is absent from the 0.4.21 bundled types
 * because those schemas are `.passthrough()`; bb's own protocol package
 * defines it and the runtime reads it from the RESULT, not the notification.
 * This bridge always sends `true` — see `continuity.ts`.
 */
export function createThreadWriter(args: {
  threadId: string;
  providerThreadId: string;
  send: (message: unknown) => void;
}): ThreadWriter {
  const { threadId, providerThreadId, send } = args;
  let pending: ThreadDelta[] = [];
  let scheduled = false;
  let usageTotal: ThreadEventTokenUsageBreakdown = ZERO_TOKEN_USAGE;

  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: "2.0", method, params });
  };

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0) return;
    const deltas = pending;
    pending = [];
    notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
  };

  const writer: ThreadWriter = {
    emit(deltas: readonly ThreadDelta[]): void {
      if (deltas.length === 0) return;
      pending.push(...deltas);
      // Batch per macrotask: the runtime accepts an array in one
      // `thread/delta`, and batching keeps a 200-block assistant message from
      // becoming 200 JSON-RPC frames.
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0);
      }
    },
    flush,
    addUsage(last, promptTokens) {
      usageTotal = addTokenUsage(usageTotal, last);
      writer.emit([
        {
          kind: "usage",
          last,
          total: usageTotal,
          modelContextWindow: NANOCODEX_CONTEXT_WINDOW_TOKENS,
        },
        // `used` is the first model call's input_tokens — the measured cost of
        // the stitched prompt, which is what the user needs to watch. The
        // running total would double-count prompt re-reads across model calls.
        ...(promptTokens === null
          ? []
          : ([
              {
                kind: "contextWindow",
                attach: "open",
                estimated: true,
                size: NANOCODEX_CONTEXT_WINDOW_TOKENS,
                used: promptTokens,
              },
            ] as const)),
      ]);
    },
    recovery(hint) {
      flush();
      notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, { ...hint, threadId });
    },
    raw(payload, coverage) {
      // ProviderRawEvent wire form; droppable by contract, so no flush.
      notify(BRIDGE_NOTIFICATION_METHODS.providerRaw, {
        jsonrpc: "2.0",
        method: coverage === "noise" ? "nanocodex/noise" : "nanocodex/unknown",
        params: payload,
      });
    },
    scribe({ ordinal, clientRequestIds }) {
      return createTurnScribe(writer, { ordinal, providerThreadId, clientRequestIds });
    },
  };

  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId,
    providerThreadId,
    sessionRestorable: true,
  });
  writer.emit([{ kind: "session.reset" }]);
  return writer;
}

/** Map nanocodex's flat per-turn `EventUsage` onto the SDK breakdown. */
export function usageBreakdown(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}): ThreadEventTokenUsageBreakdown {
  // Field-for-field rename. nanocodex's input_tokens is already the whole
  // prompt with cached_input_tokens as the cache-read subset, matching bb's
  // convention, so nothing is summed. The per-model-call `Usage` shape
  // (input_tokens_details.cached_tokens) is a DIFFERENT shape and is not
  // accepted here; see `events.ts`.
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
  };
}

// ---------------------------------------------------------------------------
// TurnScribe — turn scope
// ---------------------------------------------------------------------------

export interface TurnScribe {
  /** The ledger ordinal this turn occupies; emitted as `providerCheckpointId` on the boundary. */
  readonly ordinal: number;

  /** True once the turn settled. `session.ts` reads it to know whether a steer can still join. */
  readonly settled: boolean;

  /**
   * Open the turn. Idempotent. Called from `run.started` with nanocodex's
   * session uuid; also called by `settle()` when the child died first, then
   * with null.
   *
   * The uuid is accepted for the caller's flow but NOT stamped on the wire.
   * The runtime assembler speaks two turn-attribution dialects and mixing
   * them orphans deltas: a `turn.open` carrying `providerTurnId` (vouched)
   * never sets the assembler's current turn, so every later unstamped delta
   * — acceptance, text, usage, the boundary itself — is dropped and the turn
   * never settles. The acceptance queue this scribe relies on ("queued until
   * a turn opens") and `claimIfIdle` only exist in the anonymous dialect, so
   * the scribe emits that dialect exclusively (verified in the SDK 0.4.27
   * assembler; amp does the same).
   */
  open(providerTurnId: string | null): void;

  /**
   * Emit `input.accepted` for every id this turn is carrying. Idempotent, and
   * called by `settle()` if the caller has not called it. The coalescing pump
   * gives one turn several ids; the runtime assembler drains all pending
   * acceptances into the turn it opens, so several are legal and each settles
   * on this turn's boundary.
   */
  acceptAll(): void;

  /**
   * Add steer ids that joined this turn after construction, so they settle on
   * this turn's boundary. If `acceptAll` already ran, the new ids are accepted
   * immediately. (Deviation from the sketch: steering adds ids mid-turn and
   * the fixed constructor list cannot carry them.)
   */
  adopt(ids: readonly ClientTurnRequestId[]): void;

  /** How the turn settled, or null while it is still live. (Deviation from the sketch: `session.ts` folds the outcome into the ledger record.) */
  readonly status: ThreadEventTurnStatus | null;

  /** A `provider.warning` row for a recoverable hiccup (model retry, connection failure). (Deviation from the sketch: `normalized` non-fatal kinds need a carrier that is not a fake error.) */
  warn(w: { summary: string; details?: string }): void;

  /** Turn-namespaced key for a nanocodex-native id (`call_id`, `item_id`). */
  itemKey(nativeId: string): ItemKey;

  /** Turn-namespaced key for an event family nanocodex gives no id to (reasoning, compaction). */
  mintKey(family: string, index: number): ItemKey;

  /** Assistant prose. Closes the reasoning lane first. */
  say(text: string): void;

  /** Reasoning summary text on its own lane and key. */
  think(key: ItemKey, text: string): void;

  /** Close a reasoning lane at the model call that produced it. */
  thinkClose(key: ItemKey): void;

  /** Open an item. Flushes the text lanes first, so a tool call can never appear inside the message that announced it. */
  openItem(key: ItemKey, row: TimelineRow, parent?: ItemKey): OpenItem;

  /** Settle an opened item. Silent if the key is unknown or already closed. */
  closeItem(item: OpenItem, outcome: ItemOutcome): void;

  /** Streamed command / file-change output on an open item. */
  output(item: OpenItem, channel: "command" | "fileChange", text: string): void;

  /** `context.compacted`, after the compaction item closes. */
  compacted(): void;

  /** A provider error. `settlesTurn: false` for `run.error`, which is NOT terminal in nanocodex. */
  fail(e: { message: string; settlesTurn: boolean; category?: ProviderErrorCategory }): void;

  /**
   * Settle the turn: accept any un-accepted ids, open the turn if nothing did,
   * flush the lanes, drain still-open items, then emit the boundary — in that
   * order, because an item closed after its turn's boundary is an orphan.
   *
   * Idempotent. `thread/stop --interrupt` settles, and the child's own
   * `run.completed {status:"cancelled"}` may arrive a moment later and settle
   * again; the second call is silent.
   */
  settle(status: ThreadEventTurnStatus, opts?: { error?: { message: string } }): void;
}

/** @internal Constructed only through `ThreadWriter.scribe`. */
export function createTurnScribe(
  writer: ThreadWriter,
  args: { ordinal: number; providerThreadId: string; clientRequestIds: readonly ClientTurnRequestId[] },
): TurnScribe {
  const { ordinal, providerThreadId, clientRequestIds } = args;
  // Deterministic, no process entropy and no clock: the parity oracle replays
  // a recording and must reproduce every id byte-for-byte.
  const keyPrefix = `${providerThreadId}:t${ordinal}`;

  let opened = false;
  let acceptAllCalled = false;
  let acceptedThrough = 0;
  const ids: ClientTurnRequestId[] = [...clientRequestIds];
  let isSettled = false;
  let settledStatus: ThreadEventTurnStatus | null = null;
  /** key -> the row as opened, echoed at close. */
  const items = new Map<string, TimelineRow>();
  const assistantLaneKey = { channel: `${keyPrefix}:lane:assistant` };
  let assistantLaneOpen = false;
  const reasoningLanesOpen = new Set<ItemKey>();

  const openTurn = (_providerTurnId: string | null): void => {
    if (opened) return;
    opened = true;
    writer.emit([{ kind: "turn.open" }]);
  };

  const acceptAll = (): void => {
    acceptAllCalled = true;
    if (acceptedThrough >= ids.length) return;
    const toAccept = ids.slice(acceptedThrough);
    acceptedThrough = ids.length;
    // Acceptance is queued by the assembler until a turn opens, so this does
    // not force `turn.open`.
    writer.emit(toAccept.map((clientRequestId) => ({ kind: "input.accepted", clientRequestId })));
  };

  const closeAssistantLane = (): void => {
    if (!assistantLaneOpen) return;
    assistantLaneOpen = false;
    // textClose settles with the accumulated text and releases the key;
    // whitespace-only accumulations are suppressed centrally by the assembler.
    writer.emit([{ kind: "item.textClose", channel: "agentMessage", key: assistantLaneKey }]);
  };

  const closeReasoningLane = (key: ItemKey): void => {
    if (!reasoningLanesOpen.delete(key)) return;
    writer.emit([{ kind: "item.textClose", channel: "reasoningSummary", key: { channel: key } }]);
  };

  const flushLanes = (): void => {
    closeAssistantLane();
    for (const key of [...reasoningLanesOpen]) closeReasoningLane(key);
  };

  const drain = (status: "failed" | "interrupted"): void => {
    for (const [key, row] of items) {
      items.delete(key);
      writer.emit([
        {
          kind: "item.close",
          key: { providerItemId: key },
          status,
          item: row.item,
          presentation: row.presentation,
        },
      ]);
    }
  };

  const scribe: TurnScribe = {
    ordinal,
    get settled() {
      return isSettled;
    },
    get status() {
      return settledStatus;
    },
    open: openTurn,
    acceptAll,
    adopt(newIds) {
      if (newIds.length === 0) return;
      ids.push(...newIds);
      if (acceptAllCalled) acceptAll();
    },
    warn(w) {
      writer.emit([
        {
          kind: "provider.warning",
          vouchedTurn: true,
          summary: w.summary,
          ...(w.details === undefined ? {} : { details: w.details }),
        },
      ]);
    },
    itemKey(nativeId) {
      return `${keyPrefix}:${nativeId}` as ItemKey;
    },
    mintKey(family, index) {
      return `${keyPrefix}:${family}:${index}` as ItemKey;
    },
    say(text) {
      if (text.length === 0) return;
      for (const key of [...reasoningLanesOpen]) closeReasoningLane(key);
      openTurn(null);
      assistantLaneOpen = true;
      writer.emit([
        { kind: "item.textDelta", channel: "agentMessage", key: assistantLaneKey, text },
      ]);
    },
    think(key, text) {
      if (text.length === 0) return;
      closeAssistantLane();
      openTurn(null);
      reasoningLanesOpen.add(key);
      writer.emit([
        { kind: "item.textDelta", channel: "reasoningSummary", key: { channel: key }, text },
      ]);
    },
    thinkClose(key) {
      closeReasoningLane(key);
    },
    openItem(key, row, parent) {
      flushLanes();
      openTurn(null);
      items.set(key, row);
      writer.emit([
        {
          kind: "item.open",
          key: { providerItemId: key, ...(parent === undefined ? {} : { parentRef: parent }) },
          item: row.item,
          presentation: row.presentation,
        },
      ]);
      return { key };
    },
    closeItem(item, outcome) {
      const stored = items.get(item.key);
      if (stored === undefined) return;
      // Delete BEFORE emitting, so a re-entrant close is a no-op.
      items.delete(item.key);
      const row = outcome.row ?? stored;
      const terminal =
        outcome.status === "interrupted"
          ? {}
          : {
              ...(outcome.resultText === undefined ? {} : { resultText: outcome.resultText }),
              ...(outcome.aggregatedOutput === undefined
                ? {}
                : { aggregatedOutput: outcome.aggregatedOutput }),
              ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
            };
      writer.emit([
        {
          kind: "item.close",
          key: { providerItemId: item.key },
          status: outcome.status,
          item: row.item,
          presentation: row.presentation,
          ...terminal,
        },
      ]);
    },
    output(item, channel, text) {
      if (!items.has(item.key)) return;
      if (text.length === 0) return;
      writer.emit([
        { kind: "item.outputDelta", channel, key: { providerItemId: item.key }, text },
      ]);
    },
    compacted() {
      writer.emit([{ kind: "context.compacted" }]);
    },
    fail(e) {
      const settles = e.settlesTurn && !isSettled;
      if (settles) {
        // Drain BEFORE the error goes out: the assembler synthesizes the
        // failed boundary from `settlesTurn`, and an item closed after that
        // boundary is an orphan.
        isSettled = true;
        settledStatus = "failed";
        acceptAll();
        if (!opened) openTurn(null);
        flushLanes();
        drain("failed");
      }
      writer.emit([
        {
          kind: "provider.error",
          message: e.message,
          ...(e.category === undefined ? {} : { category: e.category }),
          ...(settles ? { settlesTurn: true } : {}),
        },
      ]);
      if (settles) writer.flush();
    },
    settle(status, opts) {
      if (isSettled) return;
      isSettled = true;
      settledStatus = status;
      const hadActivity = opened;
      acceptAll();
      if (!opened) openTurn(null);
      flushLanes();
      drain(status === "failed" ? "failed" : "interrupted");
      writer.emit([
        {
          kind: "turn.boundary",
          status,
          providerCheckpointId: String(ordinal),
          ...(hadActivity ? {} : { claimIfIdle: true }),
          ...(opts?.error === undefined ? {} : { error: opts.error }),
        },
      ]);
      // The interrupted boundary must be on the wire before thread/stop
      // answers (rule stop/interrupt-settles-before-result).
      writer.flush();
    },
  };
  return scribe;
}
