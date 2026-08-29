/**
 * `src/bridge/events.ts` — what nanocodex can say, and which of it matters.
 *
 * Schemas and classification live together because they are one body of
 * knowledge: the vocabulary of nanocodex's JSONL stream. Splitting them would
 * put the kind list in two files and let a nanocodex upgrade satisfy one
 * without the other.
 *
 * Envelope (crates/nanocodex-oai-api/src/events/stream.rs):
 *   {"protocol_version":1,"request_id":"<session uuid>","seq":N,
 *    "type":"<kind>","payload":{...}}
 *
 * `request_id` is constant for a whole `run` invocation and IS the session
 * uuid. `seq` starts at 1 with `run.started`.
 */

import { z } from "zod";
import { createProviderVisibilityMetadata } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * Every kind `AgentEventKind` serializes. Exhaustive against nanocodex 0.5.0.
 * The classification record below is keyed by this union, so a new kind in a
 * future nanocodex fails typecheck until someone classifies it — the
 * three-layer defense provider-codex gets from generated types, reduced to the
 * one layer a hand-read Rust enum can support.
 */
export const NANOCODEX_EVENT_KINDS = [
  "api.event",
  "assistant.delta",
  "assistant.message",
  "reasoning.summary.delta",
  "run.started",
  "run.steered",
  "run.error",
  "run.completed",
  "run.failed",
  "tool.call",
  "tool.result",
  "model.warmup.started",
  "model.warmup.completed",
  "model.warmup.failed",
  "model.call.started",
  "model.call.completed",
  "model.call.failed",
  "model.compaction.started",
  "model.compaction.completed",
  "model.compaction.failed",
  "model.attempt.started",
  "model.attempt.failed",
  "model.attempt.retrying",
  "model.connection.started",
  "model.connection.completed",
  "model.connection.failed",
] as const;

export type NanocodexEventKind = (typeof NANOCODEX_EVENT_KINDS)[number];

/**
 * The envelope, with `payload` deliberately left `unknown`.
 *
 * Two-stage parsing is a size decision, not a style one: `api.event` is 181 of
 * 252 lines and 408 KB of the 425 KB in the tool-run fixture (96%). Classifying
 * on `type` before touching `payload` means the firehose costs one string
 * compare, not a zod walk over a nested Responses frame.
 */
export const envelopeSchema = z
  .object({
    protocol_version: z.number(),
    request_id: z.string(),
    seq: z.number(),
    type: z.string(),
    payload: z.unknown(),
  })
  .loose();

export type NanocodexEnvelope = z.infer<typeof envelopeSchema>;

/** Only these two end the stream. `run.error` does NOT — a consumer that treats it as terminal drops the rest of a recoverable turn. */
export function isTerminalKind(kind: string): kind is "run.completed" | "run.failed" {
  return kind === "run.completed" || kind === "run.failed";
}

// ---------------------------------------------------------------------------
// Payload schemas — one per kind the bridge reads
// ---------------------------------------------------------------------------

export const runStartedSchema = z.object({ model: z.string(), effort: z.string().optional(), orchestration: z.string().optional(), workspace: z.string().nullable().optional(), instruction_bytes: z.number().optional() }).loose();

export const assistantTextSchema = z.object({
  model_call_index: z.number(),
  /** Absent on some deltas; `project.ts` falls back to `msg-${model_call_index}`. */
  item_id: z.string().optional(),
  /** Both phases are real assistant prose. `commentary` narrates, `final_answer` concludes. */
  phase: z.enum(["commentary", "final_answer"]).optional(),
  text: z.string(),
}).loose();

/** No `item_id` at all — keyed by `model_call_index`, which is why item keys must be turn-namespaced. */
export const reasoningDeltaSchema = z.object({ model_call_index: z.number(), text: z.string() }).loose();

export const toolCallSchema = z.object({
  call_id: z.string(),
  tool: z.string(),
  /**
   * Object OR raw string. In `orchestration: "local_code_mode"` the parent
   * call is `tool: "exec"` and `arguments` is a JavaScript program (verified in
   * the tool-run fixture). A schema that assumed an object would reject the
   * most common real shape.
   */
  arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  model_call_index: z.number().optional(),
}).loose();

export const toolResultSchema = z.object({
  call_id: z.string(),
  tool: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  duration_ns: z.number().optional(),
  /** Untagged `ToolOutputBody`: a plain string, or content blocks. */
  result: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string() }).loose())]).optional(),
  structured_result: z.unknown().optional(),
}).loose();

/** Per-TURN usage, flat. Distinct from the per-CALL shape below; conflating them mis-reports cache hits. */
export const eventUsageSchema = z.object({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
  total_tokens: z.number(),
}).loose();

/** Per-CALL usage: nested `input_tokens_details.cached_tokens`. Read for one number only — see `modelCallCompletedSchema`. */
export const callUsageSchema = z.object({
  input_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number().optional() }).loose().optional(),
  output_tokens: z.number(),
  total_tokens: z.number(),
}).loose();

export const modelCallCompletedSchema = z.object({
  call_index: z.number(),
  /**
   * For `call_index === 1` this is the measured cost of the stitched prompt
   * plus nanocodex's fixed overhead (~13.4k tokens in both fixtures). It is the
   * only honest number the bridge can put behind `contextWindow.used` and
   * behind the budget's calibration, so it is read here and nowhere else.
   */
  usage: callUsageSchema.nullable().optional(),
}).loose();

/** `RunTerminal`, with `RunMetrics` FLATTENED into it: `payload.usage`, not `payload.metrics.usage`. */
export const runTerminalSchema = z.object({
  /** `"cancelled"` maps to an INTERRUPTED boundary, not a completed one. */
  status: z.enum(["completed", "cancelled", "failed"]),
  usage: eventUsageSchema.optional(),
  warmup_usage: eventUsageSchema.optional(),
  /** Dollar fields are STRINGS here while the sibling `cost_usd` is a number. Neither is read today. */
  estimated_cost: z.unknown().optional(),
}).loose();

export const runErrorSchema = z.object({ message: z.string() }).loose();

export const compactionStartedSchema = z.object({
  after_model_call_index: z.number().optional(),
  active_context_tokens: z.number().optional(),
  auto_compact_token_limit: z.number().optional(),
}).loose();

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Every kind, classified exactly once.
 *
 *   normalized  translated into deltas by `project.ts`
 *   noise       dropped silently, with no `unhandled` delta and no
 *               `provider/raw` notification
 *   unknown     only ever assigned at runtime, to a kind not in this record
 *
 * `api.event` is `noise`, not `unhandled`: forwarding it would put 96% of the
 * stream's bytes onto the bb wire per turn. Its inner frames do carry things
 * worth mining later (`codex.rate_limits` -> `provider.rateLimits`), which is a
 * reason to revisit the classification, not to forward it wholesale now.
 */
export const NANOCODEX_EVENT_VISIBILITY: Record<NanocodexEventKind, "normalized" | "noise"> = {
  "api.event": "noise",
  "assistant.delta": "normalized",
  "assistant.message": "normalized",
  "reasoning.summary.delta": "normalized",
  "run.started": "normalized",
  "run.steered": "normalized",
  "run.error": "normalized",
  "run.completed": "normalized",
  "run.failed": "normalized",
  "tool.call": "normalized",
  "tool.result": "normalized",
  "model.warmup.started": "noise",
  "model.warmup.completed": "noise",
  "model.warmup.failed": "normalized",
  "model.call.started": "noise",
  "model.call.completed": "normalized",
  "model.call.failed": "normalized",
  "model.compaction.started": "normalized",
  "model.compaction.completed": "normalized",
  "model.compaction.failed": "normalized",
  "model.attempt.started": "noise",
  "model.attempt.failed": "noise",
  "model.attempt.retrying": "normalized",
  "model.connection.started": "noise",
  "model.connection.completed": "noise",
  "model.connection.failed": "normalized",
};

/**
 * The SDK's visibility helper, wired to the classification above.
 * `project.ts` reads `NANOCODEX_EVENT_VISIBILITY` directly; this packaged
 * form exists for the event tests, which check the table through the SDK's
 * `describeParsedRawEvent` contract.
 */
export const nanocodexVisibility = createProviderVisibilityMetadata({
  parseRawEvent(event) {
    const record = event as unknown as { params?: unknown; type?: unknown };
    const params =
      typeof record.params === "object" && record.params !== null
        ? (record.params as { type?: unknown })
        : record;
    return { kind: typeof params.type === "string" ? params.type : "unknown" };
  },
  describeParsedRawEvent(event) {
    const coverage =
      (NANOCODEX_EVENT_VISIBILITY as Record<string, "normalized" | "noise">)[event.kind] ??
      "unknown";
    return { kind: event.kind, coverage };
  },
});

/**
 * Parse one stdout line into an envelope, or null if it is not one.
 *
 * Never throws. nanocodex writes only JSONL on stdout, but a panic message or
 * a stray library print would otherwise take down a turn that is otherwise
 * fine.
 */
export function parseEventLine(line: string): NanocodexEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = envelopeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
