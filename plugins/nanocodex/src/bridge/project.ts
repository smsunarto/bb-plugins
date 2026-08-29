/**
 * `src/bridge/project.ts` — one nanocodex event stream to two outputs.
 *
 * A `TurnProjector` translates typed AgentEvent objects into bb timeline rows.
 * It does not own request settlement, checkpoints, or native session history.
 *
 * The projector owns no wire types: it takes parsed envelopes and calls scribe
 * methods. It constructs no `ThreadDelta` — `timeline.ts` does that.
 */

import {
  experimental_COMPACTION_PRESENTATION as COMPACTION_PRESENTATION,
  type JsonValue,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AgentEvent } from "nanocodex/host";
import {
  assistantTextSchema,
  compactionStartedSchema,
  isTerminalKind,
  modelCallCompletedSchema,
  NANOCODEX_EVENT_VISIBILITY,
  reasoningDeltaSchema,
  runErrorSchema,
  runStartedSchema,
  runTerminalSchema,
  toolCallSchema,
  toolResultSchema,
} from "./events.ts";
import {
  parseCodeModeChild,
  resultBodyText,
  resultExitCode,
  rowForToolCall,
  rowForToolResult,
} from "./shapes.ts";
import type { ItemKey, OpenItem, TimelineRow, TurnScribe } from "./timeline.ts";

export interface TurnProjector {
  /**
   * Fold one event into the timeline.
   *
   * Returns whether the event was terminal, which is the ONLY signal
   * `session.ts` uses to know the turn produced a real ending. `run.error` is
   * not terminal and returns false, keeping the turn open — nanocodex's own run
   * loop treats a stream that closes without `run.completed`/`run.failed` as an
   * error, and so does the session.
   */
  consume(envelope: AgentEvent): boolean;

  /** nanocodex's session uuid for this run, once `run.started` revealed it. */
  readonly requestId: string | null;

  /** `usage.input_tokens` from the first `model.call.completed`: the measured prompt cost. */
  readonly firstCallInputTokens: number | null;

  /** Native compactions already projected for this turn. */
  readonly compactionCount: number;
}

export interface TurnProjectorArgs {
  readonly scribe: TurnScribe;
  readonly raw: (payload: JsonValue) => void;
}

/**
 * Build the projector for one turn.
 *
 * Event handling, in the order the fixtures produce it:
 *
 *   run.started            scribe.open(request_id) then scribe.acceptAll().
 *                          Acceptance rides the real provider turn opening,
 *                          which is what `input.accepted` means.
 *   assistant.delta        scribe.say(text), accumulated per item so the full
 *                          `assistant.message` can dedup against it. Key:
 *                          item_id, else `msg-${model_call_index}`.
 *   assistant.message      says only the text the deltas did not stream, and
 *                          appends to `commentary` or sets `final` by `phase`.
 *   reasoning.summary.delta scribe.think(mintKey("reasoning", model_call_index), text).
 *   model.call.completed   closes that call's reasoning key (decided here
 *                          rather than deferring to the terminal event: a
 *                          summary that stays open across a tool call renders
 *                          as one long thought spanning unrelated work); reads
 *                          `usage.input_tokens` for call_index 1.
 *   tool.call              openItem(rowForToolCall). A code-mode child
 *                          (`<parent>/code-N`) opens with `parentRef` set to
 *                          its parent's key, so the timeline nests the real
 *                          work under the `exec` wrapper instead of showing
 *                          both flat.
 *   tool.result            closeItem, mapping status cancelled -> "interrupted";
 *                          appends a bounded `TurnAction` unless it is the
 *                          `exec` wrapper.
 *   model.compaction.*     compaction item pair, then scribe.compacted().
 *                          Reached mainly BECAUSE this bridge stitches long
 *                          prompts, so it is a first-class path, not a curio.
 *   run.error              scribe.fail({settlesTurn: false}) — the turn lives on.
 *   run.completed          usage delta — `last` is usage + warmup_usage summed
 *                          via `addTokenUsage` (the terminal reports them as
 *                          separate flat shapes; the honest per-turn spend is
 *                          the sum) — then settle("completed"), or
 *                          settle("interrupted") when payload.status is
 *                          "cancelled".
 *   run.failed             scribe.fail({settlesTurn: true}) then settle("failed").
 *   anything else          classification lookup: noise is dropped; an unknown
 *                          kind goes out as one `provider/raw` notification
 *                          (deviation from the sketch's `unhandled` delta,
 *                          resolved toward `timeline.ts`, whose `raw` doc
 *                          already names unknown kinds as its cargo).
 */
export function createTurnProjector(args: TurnProjectorArgs): TurnProjector {
  const { scribe } = args;

  let requestId: string | null = null;
  let firstCallInputTokens: number | null = null;
  // All keys come from scribe.itemKey / scribe.mintKey, so they are
  // turn-namespaced by construction and cannot alias a previous turn's items.
  const openToolItems = new Map<string, { item: OpenItem; row: TimelineRow; tool: string; arguments: string | Record<string, unknown> }>();
  const openReasoningKeys = new Map<number, ItemKey>();
  const streamedMessageText = new Map<string, string>();
  let openCompaction: OpenItem | null = null;
  let compactionIndex = 0;
  let compactionCount = 0;

  const sayNovel = (nativeId: string, fullText: string): void => {
    const streamed = streamedMessageText.get(nativeId) ?? "";
    if (fullText.startsWith(streamed)) {
      scribe.say(fullText.slice(streamed.length));
    } else if (streamed.length === 0) {
      scribe.say(fullText);
    }
    streamedMessageText.set(nativeId, fullText);
  };

  const consume = (envelope: AgentEvent): boolean => {
    switch (envelope.type) {
      case "run.started": {
        const payload = runStartedSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        requestId = envelope.request_id;
        scribe.open(envelope.request_id);
        return false;
      }
      case "assistant.delta": {
        const payload = assistantTextSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        const nativeId = payload.data.item_id ?? `msg-${payload.data.model_call_index}`;
        streamedMessageText.set(
          nativeId,
          (streamedMessageText.get(nativeId) ?? "") + payload.data.text,
        );
        scribe.say(payload.data.text);
        return false;
      }
      case "assistant.message": {
        const payload = assistantTextSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        const nativeId = payload.data.item_id ?? `msg-${payload.data.model_call_index}`;
        sayNovel(nativeId, payload.data.text);
        return false;
      }
      case "reasoning.summary.delta": {
        const payload = reasoningDeltaSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        const key = scribe.mintKey("reasoning", payload.data.model_call_index);
        openReasoningKeys.set(payload.data.model_call_index, key);
        scribe.think(key, payload.data.text);
        return false;
      }
      case "model.call.completed": {
        const payload = modelCallCompletedSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        const reasoningKey = openReasoningKeys.get(payload.data.call_index);
        if (reasoningKey !== undefined) {
          openReasoningKeys.delete(payload.data.call_index);
          scribe.thinkClose(reasoningKey);
        }
        if (payload.data.call_index === 1 && firstCallInputTokens === null) {
          firstCallInputTokens = payload.data.usage?.input_tokens ?? null;
        }
        return false;
      }
      case "tool.call": {
        const payload = toolCallSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        const { call_id: callId, tool } = payload.data;
        const child = parseCodeModeChild(callId);
        const parent = child === null ? undefined : openToolItems.get(child.parentCallId);
        const row = rowForToolCall({ tool, arguments: payload.data.arguments, callId });
        const item = scribe.openItem(scribe.itemKey(callId), row, parent?.item.key);
        openToolItems.set(callId, { item, row, tool, arguments: payload.data.arguments });
        return false;
      }
      case "tool.result": {
        const payload = toolResultSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        const { call_id: callId, tool } = payload.data;
        const open = openToolItems.get(callId);
        if (open === undefined) return false;
        openToolItems.delete(callId);
        const resultText = resultBodyText(payload.data.result);
        const exitCode = resultExitCode(payload.data.structured_result);
        if (payload.data.status === "cancelled") {
          scribe.closeItem(open.item, { status: "interrupted" });
          return false;
        }
        const status = payload.data.status;
        const terminalRow = rowForToolResult({
          opened: open.row,
          tool,
          resultText,
          structuredResult: payload.data.structured_result,
        });
        const isCommand = open.row.item.type === "command";
        scribe.closeItem(open.item, {
          status,
          ...(terminalRow === undefined ? {} : { row: terminalRow }),
          ...(isCommand
            ? {
                ...(resultText.length === 0 ? {} : { aggregatedOutput: resultText }),
                ...(exitCode === undefined ? {} : { exitCode }),
              }
            : resultText.length === 0
              ? {}
              : { resultText }),
        });
        return false;
      }
      case "model.compaction.started": {
        const payload = compactionStartedSchema.safeParse(envelope.payload);
        if (!payload.success) return false;
        compactionIndex += 1;
        openCompaction = scribe.openItem(scribe.mintKey("compaction", compactionIndex), {
          item: { type: "compaction" },
          presentation: COMPACTION_PRESENTATION,
        });
        return false;
      }
      case "model.compaction.completed": {
        if (openCompaction !== null) {
          scribe.closeItem(openCompaction, { status: "completed" });
          openCompaction = null;
        }
        compactionCount += 1;
        scribe.compacted();
        return false;
      }
      case "model.compaction.failed": {
        if (openCompaction !== null) {
          scribe.closeItem(openCompaction, { status: "failed" });
          openCompaction = null;
        }
        return false;
      }
      case "model.attempt.retrying": {
        scribe.warn({ summary: "nanocodex is retrying a model call" });
        return false;
      }
      case "model.warmup.failed":
      case "model.call.failed":
      case "model.connection.failed": {
        scribe.warn({
          summary: `nanocodex reported ${envelope.type}`,
          ...(messageOf(envelope.payload) === undefined
            ? {}
            : { details: messageOf(envelope.payload) }),
        });
        return false;
      }
      case "run.steered": {
        return false;
      }
      case "run.error": {
        const payload = runErrorSchema.safeParse(envelope.payload);
        scribe.fail({
          message: payload.success ? payload.data.message : "nanocodex reported an error",
          settlesTurn: false,
        });
        return false;
      }
      case "run.completed":
      case "run.failed": {
        const payload = runTerminalSchema.safeParse(envelope.payload);
        if (envelope.type === "run.failed" || (payload.success && payload.data.status === "failed")) {
          const message = messageOf(envelope.payload) ?? "nanocodex run failed";
          scribe.fail({ message, settlesTurn: false });
        }
        return true;
      }
      default: {
        const coverage =
          (NANOCODEX_EVENT_VISIBILITY as Record<string, "normalized" | "noise">)[envelope.type];
        if (coverage === undefined) args.raw(envelope as unknown as JsonValue);
        return isTerminalKind(envelope.type);
      }
    }
  };

  return {
    consume,
    get requestId() {
      return requestId;
    },
    get firstCallInputTokens() {
      return firstCallInputTokens;
    },
    get compactionCount() {
      return compactionCount;
    },
  };
}

function messageOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as { message?: unknown; error?: unknown };
  if (typeof record.message === "string" && record.message.length > 0) return record.message;
  if (typeof record.error === "string" && record.error.length > 0) return record.error;
  if (typeof record.error === "object" && record.error !== null) {
    const nested = (record.error as { message?: unknown }).message;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}
