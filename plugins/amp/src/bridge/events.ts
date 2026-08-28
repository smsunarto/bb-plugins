/**
 * The ONLY module that knows what Amp's `--stream-json` NDJSON looks like.
 *
 * Every consumer of the old `AmpStreamMessage` re-derived what a field means,
 * no consumer could be exhaustive, and its index signature meant a typo
 * compiled. This file closes that leak: the loose shape appears here and
 * nowhere else, and everything downstream sees `AmpEvent`, a closed union.
 *
 * The parse is total. It never throws and never returns `undefined` for a
 * message it does not recognize — unrecognized traffic becomes a
 * `{ kind: "raw" }` event, so the classification decision ("noise" vs
 * "unknown") is made once, here, with the message in hand.
 */
import type { JsonValue } from "@get-bb/plugin-sdk";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** An image Amp emitted inline, already normalized to a data payload. */
export interface AmpImage {
  readonly mimeType: string;
  readonly base64: string;
}

/** An image Amp referenced by URL. Renderable image payloads need bytes, so
 * downstream surfaces render these as links instead of fabricating an empty
 * payload. */
export interface AmpImageLink {
  readonly url: string;
}

export type AmpImageContent = AmpImage | AmpImageLink;

/** Amp's tool result, flattened from the several shapes the CLI emits. */
export interface AmpToolOutput {
  /** Result text: the string result, or text blocks joined with newlines. */
  readonly text: string;
  /** The non-string result payload when Amp sent one (content block lists,
   * Oracle reports, task summaries); null when the result was plain text. */
  readonly structured: JsonValue | null;
}

export type AmpErrorSubtype =
  | "error_during_execution"
  | "error_max_turns"
  | "unsupported_option"
  | "auth_required"
  | "unknown";

/** Token usage as Amp reports it (@ampcode/sdk `Usage`). Provider-owned:
 * mapping to the SDK usage breakdown happens in the timeline writer. */
export interface AmpUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface AmpMcpServerStatus {
  readonly name: string;
  /** Raw Amp connection status (`connected`, `awaiting-approval`, `failed`,
   * ...). Kept verbatim: the attention warning quotes it. */
  readonly status: string;
}

/**
 * One semantic thing Amp said. A closed union: adding an Amp message type is a
 * compile error in the exhaustive consumers and nowhere else.
 *
 * `parent` is Amp's `parent_tool_use_id` — the subagent that produced the
 * output, or null for the main agent. It stays a raw Amp id here.
 */
export type AmpEvent =
  /** The `system`/`init` handshake, with the tool roster Amp loaded and the
   *  per-server MCP connection status. */
  | { kind: "init"; tools: readonly string[]; mcpServers: readonly AmpMcpServerStatus[] }
  | { kind: "text"; text: string; parent: string | null }
  | { kind: "thinking"; text: string; parent: string | null }
  | { kind: "image"; image: AmpImageContent; parent: string | null }
  | {
      kind: "toolStart";
      callId: string;
      tool: string;
      input: JsonValue;
      parent: string | null;
    }
  | {
      kind: "toolEnd";
      callId: string;
      output: AmpToolOutput;
      failed: boolean;
      parent: string | null;
    }
  /** Amp echoed a user message back on the stream. The conversation
   *  supervisor uses this as the "the CLI is listening" signal (today's
   *  `awaitingInputEcho`); it produces no timeline row. */
  | { kind: "userEcho"; text: string }
  | { kind: "assistantStop"; reason: "end_turn" | "max_tokens" | "refusal" }
  | { kind: "usage"; usage: AmpUsage }
  | { kind: "resultOk"; denials: readonly string[] }
  | {
      kind: "resultError";
      subtype: AmpErrorSubtype;
      message: string;
      denials: readonly string[];
    }
  | { kind: "raw"; coverage: "noise" | "unknown"; payload: JsonValue };

/**
 * One NDJSON line, parsed. A line can produce several events (an assistant
 * message with three content blocks) or none (a heartbeat).
 *
 * `terminal` and `ampThreadId` are properties of the LINE, not of any event:
 * they are the two facts the conversation supervisor needs that the timeline
 * does not care about.
 */
export interface AmpEventBatch {
  /** Amp's own thread id (`T-…`), present on nearly every line. */
  readonly ampThreadId: string | null;
  /** True when this line means the CLI process has finished its work. */
  readonly terminal: boolean;
  readonly events: readonly AmpEvent[];
}

// ---------------------------------------------------------------------------
// Boundary parse
// ---------------------------------------------------------------------------

/**
 * Parse one message off the Amp stream. Total: any input, including a
 * non-object, yields a batch (possibly `{ terminal: false, events: [raw] }`).
 *
 * Validate here, trust the union downstream — this is the only validation
 * boundary on the Amp side.
 */
export function parseAmpBatch(message: unknown): AmpEventBatch {
  if (!isRecord(message) || typeof message.type !== "string") {
    return { ampThreadId: null, terminal: false, events: [raw("unknown", message)] };
  }
  const ampThreadId =
    typeof message.session_id === "string" && message.session_id.length > 0
      ? message.session_id
      : null;
  switch (message.type) {
    case "system":
      return parseSystem(message, ampThreadId);
    case "assistant":
      return { ampThreadId, terminal: false, events: parseAssistant(message) };
    case "user":
      return { ampThreadId, terminal: false, events: parseUser(message) };
    case "result":
      return { ampThreadId, terminal: true, events: parseResult(message) };
    default:
      return { ampThreadId, terminal: false, events: [raw("unknown", message)] };
  }
}

function parseSystem(message: Record<string, unknown>, ampThreadId: string | null): AmpEventBatch {
  if (message.subtype === "init") {
    const tools = Array.isArray(message.tools)
      ? message.tools.filter((tool): tool is string => typeof tool === "string")
      : [];
    const mcpServers: AmpMcpServerStatus[] = [];
    if (Array.isArray(message.mcp_servers)) {
      for (const entry of message.mcp_servers) {
        if (!isRecord(entry)) continue;
        if (typeof entry.name !== "string" || typeof entry.status !== "string") continue;
        mcpServers.push({ name: entry.name, status: entry.status });
      }
    }
    return { ampThreadId, terminal: false, events: [{ kind: "init", tools, mcpServers }] };
  }
  if (typeof message.error === "string") {
    const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
    return {
      ampThreadId,
      terminal: true,
      events: [
        {
          kind: "resultError",
          subtype: classifyAmpError(subtype, message.error),
          message: message.error,
          denials: [],
        },
      ],
    };
  }
  return { ampThreadId, terminal: false, events: [raw("noise", message)] };
}

function parseAssistant(message: Record<string, unknown>): AmpEvent[] {
  const parent = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
  const inner = isRecord(message.message) ? message.message : undefined;
  const content = inner?.content;
  const events: AmpEvent[] = [];
  if (typeof content === "string") {
    if (content.length > 0) events.push({ kind: "text", text: content, parent });
  } else if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry)) continue;
      switch (entry.type) {
        case "text":
          if (typeof entry.text === "string" && entry.text.length > 0) {
            events.push({ kind: "text", text: entry.text, parent });
          }
          break;
        case "thinking":
          if (typeof entry.thinking === "string" && entry.thinking.length > 0) {
            events.push({ kind: "thinking", text: entry.thinking, parent });
          }
          break;
        case "image": {
          const image = parseAmpImageBlock(entry);
          if (image !== null) events.push({ kind: "image", image, parent });
          break;
        }
        case "tool_use":
          if (typeof entry.id === "string") {
            events.push({
              kind: "toolStart",
              callId: entry.id,
              tool: typeof entry.name === "string" ? entry.name : "Tool",
              // Stream lines come from JSON.parse, so input is JSON data.
              input: (entry.input ?? null) as JsonValue,
              parent,
            });
          }
          break;
        default:
          break;
      }
    }
  }
  const usage = parseUsage(inner?.usage);
  if (usage !== null) events.push({ kind: "usage", usage });
  const stop = inner?.stop_reason;
  if (stop === "end_turn" || stop === "max_tokens" || stop === "refusal") {
    events.push({ kind: "assistantStop", reason: stop });
  }
  return events;
}

function parseUser(message: Record<string, unknown>): AmpEvent[] {
  const rawParent = message.parent_tool_use_id;
  const parent = typeof rawParent === "string" ? rawParent : null;
  const inner = isRecord(message.message) ? message.message : undefined;
  const content = inner?.content;
  if (!Array.isArray(content)) return [];
  if (rawParent === undefined || rawParent === null) {
    const echoed = echoedText(content);
    if (echoed !== null) return [{ kind: "userEcho", text: echoed }];
  }
  const events: AmpEvent[] = [];
  for (const entry of content) {
    if (!isRecord(entry) || entry.type !== "tool_result") continue;
    if (typeof entry.tool_use_id !== "string") continue;
    events.push({
      kind: "toolEnd",
      callId: entry.tool_use_id,
      output: parseToolOutput(entry.content),
      failed: entry.is_error === true,
      parent,
    });
  }
  return events;
}

/** The prompt-echo signal: a top-level user message whose every content block
 * is a text block. Mixed content (tool results) is not an echo. */
function echoedText(content: readonly unknown[]): string | null {
  let text = "";
  for (const entry of content) {
    if (!isRecord(entry) || entry.type !== "text" || typeof entry.text !== "string") return null;
    text += entry.text;
  }
  return text;
}

function parseResult(message: Record<string, unknown>): AmpEvent[] {
  const events: AmpEvent[] = [];
  const usage = parseUsage(message.usage);
  if (usage !== null) events.push({ kind: "usage", usage });
  const denials = Array.isArray(message.permission_denials)
    ? message.permission_denials.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (message.is_error === true) {
    const error = typeof message.error === "string" ? message.error : "unknown error";
    const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
    events.push({
      kind: "resultError",
      subtype: classifyAmpError(subtype, error),
      message: error,
      denials,
    });
  } else {
    events.push({ kind: "resultOk", denials });
  }
  return events;
}

function parseUsage(value: unknown): AmpUsage | null {
  if (!isRecord(value)) return null;
  if (typeof value.input_tokens !== "number" || typeof value.output_tokens !== "number") {
    return null;
  }
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cacheCreationInputTokens:
      typeof value.cache_creation_input_tokens === "number" ? value.cache_creation_input_tokens : 0,
    cacheReadInputTokens:
      typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens : 0,
  };
}

function parseToolOutput(content: unknown): AmpToolOutput {
  if (typeof content === "string") return { text: content, structured: null };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
        if (entry.text.length > 0) parts.push(entry.text);
      }
    }
    // Stream lines come from JSON.parse, so array content is JSON data.
    return { text: parts.join("\n"), structured: content as JsonValue };
  }
  if (content === null || content === undefined) return { text: "", structured: null };
  return { text: "", structured: content as JsonValue };
}

/** Parse one Amp image content block (`{type:"image", source:{...}}`).
 * Callers gate on `type === "image"`; this validates and normalizes the
 * source. Returns null for payloads no renderer could display. */
export function parseAmpImageBlock(block: unknown): AmpImageContent | null {
  if (!isRecord(block)) return null;
  const source = block.source;
  if (!isRecord(source)) return null;
  if (
    source.type === "base64" &&
    typeof source.data === "string" &&
    typeof source.media_type === "string"
  ) {
    const base64 = normalizeBase64(source.data);
    const mimeType = normalizeImageMimeType(source.media_type);
    if (base64 !== null && mimeType !== null) return { mimeType, base64 };
  }
  if (source.type === "url" && typeof source.url === "string" && source.url.trim().length > 0) {
    return { url: source.url.trim() };
  }
  return null;
}

function normalizeBase64(value: string): string | null {
  const data = value.replaceAll(/\s/g, "");
  if (data.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const withoutPadding = data.replace(/=+$/, "");
  if (withoutPadding.length % 4 === 1) return null;
  const normalized = withoutPadding.padEnd(
    withoutPadding.length + ((4 - (withoutPadding.length % 4)) % 4),
    "=",
  );
  return Buffer.from(normalized, "base64").toString("base64") === normalized ? normalized : null;
}

function normalizeImageMimeType(value: string): string | null {
  const mimeType = value.split(";", 1)[0].trim().toLowerCase();
  return /^image\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) ? mimeType : null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Amp CLI auth failures, matched on the error text Amp actually emits. */
export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid or missing api key") ||
    lower.includes("run 'amp login'") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("no api key found") ||
    (lower.includes("api key") && (lower.includes("missing") || lower.includes("invalid")))
  );
}

/**
 * Classify an Amp error into the closed subtype set. The branch order mirrors
 * the runtime's handling: `error_max_turns` stays a turn-limit stop even when
 * the text happens to look auth-shaped, and `error_during_execution` only
 * escalates past a soft failure when the text is an auth failure.
 */
export function classifyAmpError(subtype: string | undefined, message: string): AmpErrorSubtype {
  if (subtype === "error_max_turns") return "error_max_turns";
  if (subtype === "error_during_execution") {
    return isAuthError(message) ? "auth_required" : "error_during_execution";
  }
  if (isAuthError(message)) return "auth_required";
  if (parseUnsupportedFlag(message) !== null) return "unsupported_option";
  return "unknown";
}

/**
 * Pull the flag name out of an Amp "unknown option" error, lowercased, so the
 * conversation supervisor can drop exactly the option that caused it and
 * replay. Returns null when the error is not an unknown-flag error.
 */
export function parseUnsupportedFlag(message: string): string | null {
  const match = /unknown option\s+['"`‘’]?--([a-z0-9-]+)/i.exec(message);
  return match === null ? null : match[1].toLowerCase();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function raw(coverage: "noise" | "unknown", payload: unknown): AmpEvent {
  return { kind: "raw", coverage, payload: toJsonValue(payload) };
}

function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
