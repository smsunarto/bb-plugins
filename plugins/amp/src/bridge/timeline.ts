/**
 * `src/bridge/timeline.ts` — the ONE place that knows ThreadDelta grammar v3.
 *
 * Two writers, one file, because they are two halves of a single policy: how
 * this plugin's deltas reach the wire.
 *
 *   ThreadWriter — session-scoped. Owns identity, session boundaries, the
 *                  running usage total, and the ordering guarantee.
 *   TurnScribe   — turn-scoped. Owns text lanes, the open-item table, the
 *                  flush-before-item rule, and the drain at settlement.
 *
 * A scribe writes THROUGH its writer: the scribe adds grammar policy (lanes,
 * close-completeness, drain), the writer adds session policy (identity gate,
 * usage accumulation, ordering).
 *
 * Nothing outside this file constructs a `ThreadDelta`. `project.ts` calls
 * scribe methods; `session.ts` calls writer methods. Grep for `kind: "item.` —
 * it should only ever match here.
 */

import {
  BRIDGE_NOTIFICATION_METHODS,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  type DeltaItemShape,
  type DeltaPresentation,
  type JsonValue,
  type ProviderErrorCategory,
  type ThreadDelta,
  type ThreadEventItemStatus,
  type ThreadEventTokenUsageBreakdown,
  type ThreadEventTurnStatus,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AmpUsage } from "./events.ts";

// ---------------------------------------------------------------------------
// The pair that makes presentation non-optional
// ---------------------------------------------------------------------------

/**
 * A timeline row: what the item IS and how it READS, as one value.
 *
 * Grammar v3 makes `presentation` optional on `item.open` for core shapes and
 * required for `extension` shapes. Pairing the two here means the plugin
 * cannot name a row without saying how it renders.
 */
export interface TimelineRow {
  readonly item: DeltaItemShape;
  readonly presentation: DeltaPresentation;
  /**
   * Runs exactly once when the item settles — however it settles: a close the
   * provider sent, or the scribe's drain at turn end. The Oracle projector
   * registers the report-store completion here, beside the row it belongs to,
   * so a drained turn can never leave a spinning card.
   */
  readonly onSettle?: (status: ThreadEventItemStatus) => void;
}

/**
 * A handle to an item this turn opened. Only `TurnScribe.openItem` mints one,
 * so `closeItem` cannot name an item that was never opened.
 */
export interface OpenItem {
  readonly __brand: "OpenItem";
  readonly key: string;
}

/** How an item ended. */
export type ItemOutcome =
  | {
      status: "completed" | "failed";
      /** Terminal shape, when it differs from the opened shape (a tool call
       *  gains its output). Omitted means "the opened row was already
       *  terminal", and the scribe echoes it. */
      row?: TimelineRow;
      resultText?: string;
      aggregatedOutput?: string;
      exitCode?: number;
      approvalDenied?: boolean;
    }
  | { status: "interrupted"; row?: TimelineRow };

// ---------------------------------------------------------------------------
// ThreadWriter — session scope
// ---------------------------------------------------------------------------

/** An unsolicited recovery hint. `message` is required by the runtime's
 *  `providerRecoveryNotificationSchema` (deviation from the sketch, which had
 *  it optional). */
export interface ProviderRecoveryHint {
  readonly kind: "authRequired" | "sessionArchived" | "staleTurn" | "rateLimited";
  readonly retryable: boolean;
  readonly message: string;
}

export interface ThreadWriter {
  /**
   * Append deltas for this thread. Ordering is FIFO and preserved across
   * every caller — the scribe, the session, and the tool proxy all funnel
   * here, which is why there is exactly one queue per thread.
   */
  emit(deltas: readonly ThreadDelta[]): void;

  /** Put every pending delta on the wire now. `thread/stop` uses this to get
   *  a boundary out before it answers. */
  flush(): void;

  /**
   * Add one usage reading and emit the `usage` delta. The running total lives
   * here and nowhere else. Reset by construction, never by a setter.
   */
  addUsage(last: ThreadEventTokenUsageBreakdown, modelContextWindow: number | null): void;

  /** `session/replaced`. Mandatory on every session rebuild. */
  replaced(args: { providerThreadId: string | null; reason: string; contextLost: boolean }): void;

  /** `provider/recovery` — unsolicited hints only. A hint that explains a
   *  request failure rides that request's `error.data.recovery` instead; the
   *  two carriers are mutually exclusive and this method is the unsolicited
   *  one. */
  recovery(hint: ProviderRecoveryHint): void;

  /** `provider/raw`. Droppable diagnostics; never blocks real deltas. */
  raw(payload: JsonValue, coverage: "noise" | "unknown"): void;

  /** Start a scribe for one bb turn. */
  scribe(): TurnScribe;
}

/**
 * Construct a thread writer. Emits `thread/identity` and — when the id space
 * is fresh — the `session.reset` delta, in that order, before returning.
 *
 * The identity-before-any-delta invariant is enforced by construction: there
 * is no way to obtain a writer without identity having gone out, and no way
 * to emit a delta without a writer.
 */
export function createThreadWriter(args: {
  threadId: string;
  providerThreadId: string;
  sessionRestorable: boolean;
  /** True on `thread/start` and on a resume that rebuilds context; false when
   *  resuming into an id-space that survived. */
  resetIdSpace: boolean;
  send: (message: unknown) => void;
}): ThreadWriter {
  const { threadId, providerThreadId, sessionRestorable, resetIdSpace, send } = args;
  let pending: ThreadDelta[] = [];
  let scheduled = false;
  let usageTotal: ThreadEventTokenUsageBreakdown = ZERO_TOKEN_USAGE;
  let turnOrdinal = 0;

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
    addUsage(last, modelContextWindow) {
      usageTotal = addTokenUsage(usageTotal, last);
      writer.emit([
        { kind: "usage", last, total: usageTotal, modelContextWindow },
        {
          kind: "contextWindow",
          attach: "open",
          estimated: true,
          size: modelContextWindow,
          // Amp reports per-call usage; the last reading's own total is the
          // best estimate of the context in use (the running total would sum
          // prompt re-reads across calls).
          used: last.totalTokens,
        },
      ]);
    },
    replaced({ providerThreadId: nextProviderThreadId, reason, contextLost }) {
      flush();
      notify(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
        threadId,
        providerThreadId: nextProviderThreadId,
        reason,
        contextLost,
      });
    },
    recovery(hint) {
      flush();
      notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, { ...hint, threadId });
    },
    raw(payload, coverage) {
      // ProviderRawEvent wire form; droppable by contract, so no flush.
      notify(BRIDGE_NOTIFICATION_METHODS.providerRaw, {
        jsonrpc: "2.0",
        method: coverage === "noise" ? "amp/noise" : "amp/unknown",
        params: payload,
      });
    },
    scribe() {
      turnOrdinal += 1;
      return createTurnScribe(writer, `${threadId}:t${turnOrdinal}`);
    },
  };

  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId,
    providerThreadId,
    sessionRestorable,
  });
  if (resetIdSpace) {
    // One statement's worth of policy: a fresh id space and a zero usage
    // total can never disagree.
    usageTotal = ZERO_TOKEN_USAGE;
    writer.emit([{ kind: "session.reset" }]);
  }
  return writer;
}

/** Map Amp's Anthropic-flavored usage to the SDK breakdown. Amp reports the
 *  cache split beside `inputTokens`; bb's `inputTokens` is the whole prompt,
 *  with `cachedInputTokens` as the cache-read subset. */
export function usageBreakdown(usage: AmpUsage): ThreadEventTokenUsageBreakdown {
  const inputTokens =
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadInputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + usage.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// TurnScribe — turn scope
// ---------------------------------------------------------------------------

export interface TurnScribe {
  /**
   * Report that a client input was consumed. Called only from the delivery
   * promise in `conversation.ts` — never from the request handler — so
   * `input.accepted` means "Amp took it", not "we queued it".
   */
  accept(clientRequestId: string): void;

  /** Open the turn. Idempotent. */
  open(): void;

  /** Assistant text. Closes the reasoning lane first. */
  say(text: string): void;

  /** Reasoning text. Closes the assistant lane first. */
  think(text: string): void;

  /** A non-timeline warning row, replacing the fake assistant speech the ACP
   *  bridge injects for MCP attachment failures and permission denials. */
  warn(w: {
    summary: string;
    details?: string;
    category?: "compaction-skipped" | "config" | "deprecation" | "general";
  }): void;

  /**
   * Open an item. Flushes both text lanes first, so a tool call can never
   * appear inside the assistant message that announced it.
   *
   * `key` is the Amp tool-use id when there is one, or a `mintKey` value.
   * Never process entropy: the parity oracle replays the recording and has to
   * reproduce the id.
   */
  openItem(key: string, row: TimelineRow): OpenItem;

  /** Settle an opened item. Fires the row's `onSettle` exactly once. */
  closeItem(item: OpenItem, outcome: ItemOutcome): void;

  /** Open and close in one step, for work with no streaming phase. */
  recordItem(key: string, row: TimelineRow, outcome: ItemOutcome): void;

  /** Progress on an open item; throttled centrally by the assembler. */
  progress(item: OpenItem, message: string): void;

  /** Plugin-declared thread state, latest-wins. Send the whole state, never a
   *  diff. */
  state(extensionKind: `${string}/${string}`, payload: JsonValue): void;

  /**
   * A provider error. `settlesTurn: true` drains the still-open items as
   * failed and lets the assembler settle the turn from the `provider.error`
   * delta itself (it synthesizes the failed boundary — no second boundary
   * from the scribe).
   */
  fail(e: {
    message: string;
    detail?: string;
    settlesTurn: boolean;
    category?: ProviderErrorCategory;
  }): void;

  /**
   * Settle the turn. Flushes both lanes, drains every still-open item, then
   * emits the boundary — in that order, because an item closed after its
   * turn's boundary is an orphan.
   *
   * Idempotent: `thread/stop --interrupt` settles, and the CLI's own `result`
   * line arrives a moment later and settles again; the second call is silent.
   *
   * `claimIfIdle` defaults to "the turn never opened" — a `result` line with
   * no work is a legitimate zero-work turn.
   */
  settle(
    status: ThreadEventTurnStatus,
    opts?: { error?: { message: string }; claimIfIdle?: boolean },
  ): void;

  /** Deterministic bridge-minted key: `${threadId}:t${ordinal}:${family}:${n}`.
   *  For provider events with no Amp id (images). */
  mintKey(family: string): string;

  /** True once the turn has settled. `session.ts` reads this to know whether
   *  a steer is still legal. */
  readonly settled: boolean;
}

type LaneName = "assistant" | "thinking";

const LANE_WIRE_CHANNEL = {
  assistant: "agentMessage",
  thinking: "reasoningText",
} as const;

export function createTurnScribe(writer: ThreadWriter, turnKeyPrefix: string): TurnScribe {
  let opened = false;
  let isSettled = false;
  /** key → the row as opened, echoed at close. */
  const items = new Map<string, TimelineRow>();
  const laneOpen: Record<LaneName, boolean> = { assistant: false, thinking: false };
  const mintCounters = new Map<string, number>();

  const laneKey = (lane: LaneName): { channel: string } => ({
    channel: `${turnKeyPrefix}:${lane}`,
  });

  const ensureOpen = (): void => {
    if (opened) return;
    opened = true;
    writer.emit([{ kind: "turn.open" }]);
  };

  const closeLane = (lane: LaneName): void => {
    if (!laneOpen[lane]) return;
    laneOpen[lane] = false;
    // textClose settles with the accumulated text and releases the key;
    // whitespace-only accumulations are suppressed centrally by the assembler.
    writer.emit([{ kind: "item.textClose", channel: LANE_WIRE_CHANNEL[lane], key: laneKey(lane) }]);
  };

  const flushLanes = (): void => {
    closeLane("assistant");
    closeLane("thinking");
  };

  const speak = (lane: LaneName, text: string): void => {
    if (text.length === 0) return; // A14: empty text emits nothing.
    closeLane(lane === "assistant" ? "thinking" : "assistant");
    ensureOpen();
    laneOpen[lane] = true;
    writer.emit([
      { kind: "item.textDelta", channel: LANE_WIRE_CHANNEL[lane], key: laneKey(lane), text },
    ]);
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
      row.onSettle?.(status);
    }
  };

  const scribe: TurnScribe = {
    accept(clientRequestId) {
      // Acceptance is queued by the assembler until a turn opens, so this
      // does not force `turn.open` — a zero-work turn claims it at boundary.
      writer.emit([{ kind: "input.accepted", clientRequestId }]);
    },
    open: ensureOpen,
    say(text) {
      speak("assistant", text);
    },
    think(text) {
      speak("thinking", text);
    },
    warn(w) {
      writer.emit([
        {
          kind: "provider.warning",
          vouchedTurn: true,
          summary: w.summary,
          ...(w.details === undefined ? {} : { details: w.details }),
          ...(w.category === undefined ? {} : { category: w.category }),
        },
      ]);
    },
    openItem(key, row) {
      flushLanes();
      ensureOpen();
      items.set(key, row);
      writer.emit([
        {
          kind: "item.open",
          key: { providerItemId: key },
          item: row.item,
          presentation: row.presentation,
        },
      ]);
      return { __brand: "OpenItem", key };
    },
    closeItem(item, outcome) {
      const stored = items.get(item.key);
      if (stored === undefined) return;
      // Delete BEFORE the callback, so a re-entrant close is a no-op.
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
              ...(outcome.approvalDenied === true ? { approvalStatus: "denied" as const } : {}),
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
      stored.onSettle?.(outcome.status);
    },
    recordItem(key, row, outcome) {
      scribe.closeItem(scribe.openItem(key, row), outcome);
    },
    progress(item, message) {
      if (!items.has(item.key)) return;
      writer.emit([{ kind: "item.progress", key: { providerItemId: item.key }, message }]);
    },
    state(extensionKind, payload) {
      writer.emit([{ kind: "extension.state", extensionKind, payload }]);
    },
    fail(e) {
      const settles = e.settlesTurn && !isSettled;
      if (settles) {
        // Drain BEFORE the error goes out: the assembler synthesizes the
        // failed boundary from `settlesTurn`, and an item closed after that
        // boundary is an orphan.
        isSettled = true;
        flushLanes();
        drain("failed");
      }
      writer.emit([
        {
          kind: "provider.error",
          message: e.message,
          ...(e.detail === undefined ? {} : { detail: e.detail }),
          ...(e.category === undefined ? {} : { category: e.category }),
          ...(settles ? { settlesTurn: true } : {}),
        },
      ]);
      if (settles) writer.flush();
    },
    settle(status, opts) {
      if (isSettled) return;
      isSettled = true;
      flushLanes();
      drain(status === "failed" ? "failed" : "interrupted");
      const claimIfIdle = opts?.claimIfIdle ?? !opened;
      writer.emit([
        {
          kind: "turn.boundary",
          status,
          ...(claimIfIdle ? { claimIfIdle: true } : {}),
          ...(opts?.error === undefined ? {} : { error: opts.error }),
        },
      ]);
      writer.flush();
    },
    mintKey(family) {
      const next = (mintCounters.get(family) ?? 0) + 1;
      mintCounters.set(family, next);
      return `${turnKeyPrefix}:${family}:${next}`;
    },
    get settled() {
      return isSettled;
    },
  };
  return scribe;
}
