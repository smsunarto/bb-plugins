import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type ThreadEventRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
type EventOf<T extends ThreadEventRow["type"]> = Extract<ThreadEventRow, { type: T }>;
type CompletedItem = EventOf<"item/completed">["data"]["item"];
/** One BB usage report; `total` reports are cumulative for the provider session. */
export type TokenUsage = EventOf<"thread/tokenUsage/updated">["data"]["tokenUsage"]["total"];

export type ContentMode = "full" | "metadata";

export type TraceThread = Pick<
  Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
  | "environmentId"
  | "id"
  | "originPluginId"
  | "parentThreadId"
  | "projectId"
  | "providerId"
  | "sourceThreadId"
  | "title"
  | "visibility"
>;

type SpanKind = "WORKFLOW" | "LLM" | "TOOL" | "MCP_TOOL" | "AGENT" | "TASK";
type MetadataValue = string | number | boolean;

/** One node of the nested JSON body that Neatlogs `POST /v1/trace` accepts. */
export interface NeatlogsSpan {
  name: string;
  kind: SpanKind;
  start: string;
  end: string;
  status: "OK" | "ERROR";
  error?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  tokens?: { prompt: number; completion: number; total: number };
  tool_name?: string;
  metadata?: Record<string, MetadataValue>;
  attributes?: Record<string, MetadataValue>;
  children?: NeatlogsSpan[];
}

/** The root name is the Neatlogs workflow, so every BB turn shares one. */
export const WORKFLOW_NAME = "bb-agent-turn";
const CONTENT_MAX_CHARS = 16_000;

/**
 * How each completed BB item appears in the trace. `null` items fold into the
 * LLM step that produced them. `splitsStep` marks calls the model makes, which
 * end its round trip until their results return.
 */
const ITEM_SPANS: Record<CompletedItem["type"], { kind: SpanKind; splitsStep: boolean } | null> = {
  agentMessage: null,
  reasoning: null,
  userMessage: null,
  commandExecution: { kind: "TOOL", splitsStep: true },
  fileChange: { kind: "TOOL", splitsStep: true },
  fileRead: { kind: "TOOL", splitsStep: true },
  imageView: { kind: "TOOL", splitsStep: true },
  imageGeneration: { kind: "TOOL", splitsStep: true },
  search: { kind: "TOOL", splitsStep: true },
  webFetch: { kind: "TOOL", splitsStep: true },
  webSearch: { kind: "TOOL", splitsStep: true },
  toolCall: { kind: "TOOL", splitsStep: true },
  backgroundTask: { kind: "TASK", splitsStep: true },
  delegation: { kind: "AGENT", splitsStep: true },
  plan: { kind: "TASK", splitsStep: false },
  planSteps: { kind: "TASK", splitsStep: true },
  contextCompaction: { kind: "TASK", splitsStep: false },
  extension: { kind: "TASK", splitsStep: false },
};

const LLM_PROVIDER_BY_BB_PROVIDER: Record<string, string> = {
  "claude-code": "anthropic",
  codex: "openai",
  nanocodex: "openai",
};

interface ItemRecord {
  item: CompletedItem;
  startMs: number;
  endMs: number;
}

/**
 * One provider round trip inside a BB turn. BB does not emit model request
 * boundaries, so a step is inferred from the item stream: it starts when the
 * previous step's calls have all finished and ends when its own first call
 * starts. Steps without calls end when their last item completes.
 */
interface LlmStep {
  startMs: number;
  endMs: number;
  items: ItemRecord[];
  calls: ItemRecord[];
}

function iso(epochMs: number): string {
  return new Date(Math.max(0, epochMs)).toISOString();
}

/** Keep one field's content small enough that a long turn stays far below the 50 MB request cap. */
function bounded(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= CONTENT_MAX_CHARS
      ? value
      : `${value.slice(0, CONTENT_MAX_CHARS)}… [truncated ${value.length - CONTENT_MAX_CHARS} chars]`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length <= CONTENT_MAX_CHARS) return value;
  return { truncated: true, chars: encoded.length, preview: encoded.slice(0, CONTENT_MAX_CHARS) };
}

/** BB model IDs may carry a context suffix such as `claude-opus-5[1m]`. */
function pricingModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

function splitsStep(item: CompletedItem): boolean {
  return ITEM_SPANS[item.type]?.splitsStep ?? false;
}

function groupLlmSteps(records: readonly ItemRecord[], turnStartMs: number): LlmStep[] {
  const steps: LlmStep[] = [];
  let current: LlmStep | null = null;
  let nextStart = turnStartMs;

  const close = (step: LlmStep): void => {
    if (step.calls.length > 0) {
      step.endMs = Math.min(...step.calls.map((call) => call.startMs));
      nextStart = Math.max(...step.calls.map((call) => call.endMs));
    } else {
      step.endMs = Math.max(...step.items.map((record) => record.endMs));
      nextStart = step.endMs;
    }
    step.endMs = Math.max(step.startMs, step.endMs);
    steps.push(step);
  };

  for (const record of records) {
    const call = splitsStep(record.item);
    const callsDone =
      current !== null &&
      current.calls.length > 0 &&
      record.startMs >= Math.max(...current.calls.map((entry) => entry.endMs));
    if (current !== null && current.calls.length > 0 && (!call || callsDone)) {
      close(current);
      current = null;
    }
    current ??= { startMs: nextStart, endMs: nextStart, items: [], calls: [] };
    if (call) current.calls.push(record);
    else current.items.push(record);
  }
  if (current !== null) close(current);
  return steps;
}

function itemName(item: CompletedItem): string {
  return item.type === "toolCall" ? item.tool : item.type;
}

function itemFailure(item: CompletedItem): string | null {
  if (
    item.type === "commandExecution" &&
    typeof item.exitCode === "number" &&
    item.exitCode !== 0
  ) {
    return `exit code ${item.exitCode}`;
  }
  if (item.type === "toolCall" && item.error !== undefined) return "tool call failed";
  if ("status" in item && item.status === "failed") return `${item.type} failed`;
  return null;
}

function itemInput(item: CompletedItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return item.cwd ? { command: item.command, cwd: item.cwd } : { command: item.command };
    case "toolCall":
      return item.arguments ?? {};
    case "webSearch":
      return { queries: item.queries };
    case "webFetch":
      return { url: item.url, pattern: item.pattern, prompt: item.prompt };
    case "imageView":
      return { path: item.path };
    case "fileRead":
      return { path: item.path, command: item.cmd };
    case "search":
      return { query: item.query, path: item.path, mode: item.mode, command: item.cmd };
    case "fileChange":
      return { paths: item.changes.map((change) => change.path) };
    case "backgroundTask":
      return { description: item.description };
    case "delegation":
      return { label: item.label };
    default:
      return undefined;
  }
}

function itemOutput(item: CompletedItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return { exitCode: item.exitCode, output: item.aggregatedOutput };
    case "toolCall":
      return { status: item.status, result: item.result, error: item.error };
    case "webSearch":
    case "webFetch":
      return item.resultText;
    case "fileChange":
      return item.changes;
    case "plan":
      return item.text;
    case "planSteps":
      return item.steps;
    case "backgroundTask":
    case "delegation":
      return item.summary;
    default:
      return undefined;
  }
}

function itemMetadata(item: CompletedItem): Record<string, MetadataValue> {
  const metadata: Record<string, MetadataValue> = { itemId: item.id, itemType: item.type };
  if ("status" in item) metadata.status = item.status;
  if (item.type === "toolCall" && item.server !== undefined) metadata.mcpServer = item.server;
  if (item.type === "commandExecution" && typeof item.exitCode === "number") {
    metadata.exitCode = item.exitCode;
  }
  if (item.type === "backgroundTask") {
    metadata.taskType = item.taskType;
    metadata.taskStatus = item.taskStatus;
  }
  if (item.type === "delegation") {
    metadata.background = item.background;
    metadata.childRef = item.childRef;
  }
  return metadata;
}

function itemSpan(record: ItemRecord, fullContent: boolean): NeatlogsSpan {
  const { item } = record;
  const kind =
    item.type === "toolCall" && item.server !== undefined
      ? "MCP_TOOL"
      : (ITEM_SPANS[item.type]?.kind ?? "TASK");
  const failure = itemFailure(item);
  const span: NeatlogsSpan = {
    name: itemName(item),
    kind,
    start: iso(record.startMs),
    end: iso(record.endMs),
    status: failure === null ? "OK" : "ERROR",
    metadata: itemMetadata(item),
  };
  if (failure !== null) span.error = failure;
  if (kind === "TOOL" || kind === "MCP_TOOL") span.tool_name = itemName(item);
  if (fullContent) {
    const input = itemInput(item);
    const output = itemOutput(item);
    if (input !== undefined) span.input = bounded(input);
    if (output !== undefined && output !== null) span.output = bounded(output);
  }
  return span;
}

/** Every user message of the turn, including ones that steered it mid-run. */
function visibleUserText(events: readonly ThreadEventRow[]): string | null {
  const text = events
    .flatMap((event) =>
      event.type === "client/turn/requested" && event.data.initiator === "user"
        ? event.data.input
        : [],
    )
    .flatMap((input) =>
      input.type === "text" && input.visibility !== "agent-only" ? [input.text.trim()] : [],
    )
    .filter(Boolean)
    .join("\n\n");
  return text === "" ? null : text;
}

function stepText(step: LlmStep): string {
  return step.items
    .flatMap((record) => (record.item.type === "agentMessage" ? [record.item.text] : []))
    .join("\n");
}

export const ZERO_USAGE: TokenUsage = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * The turn's usage as the change in BB's cumulative `total` report. BB prunes
 * all but a thread's latest usage report, so per-request `last` reports cannot
 * be summed. Null when either end is unknown. A drop means the provider
 * session restarted during the turn, so the new total is the turn's usage.
 */
function usageDelta(latest: TokenUsage | null, baseline: TokenUsage | null): TokenUsage | null {
  if (latest === null || baseline === null) return null;
  if (latest.totalTokens < baseline.totalTokens) return latest;
  const delta = (key: keyof TokenUsage): number =>
    Math.max(0, (latest[key] ?? 0) - (baseline[key] ?? 0));
  return {
    totalTokens: delta("totalTokens"),
    inputTokens: delta("inputTokens"),
    cachedInputTokens: delta("cachedInputTokens"),
    cacheReadInputTokens: delta("cacheReadInputTokens"),
    cacheWriteInputTokens: delta("cacheWriteInputTokens"),
    outputTokens: delta("outputTokens"),
    reasoningOutputTokens: delta("reasoningOutputTokens"),
  };
}

export interface AssembleTurnTraceInput {
  contentMode: ContentMode;
  /** Events after the thread checkpoint, ending with one `turn/completed`. */
  events: readonly ThreadEventRow[];
  thread: TraceThread;
  /** The cumulative usage report before this turn, or null when unknown. */
  usageBaseline: TokenUsage | null;
}

export interface AssembledTurn {
  /** Null when the turn started before the window (before the checkpoint). */
  trace: NeatlogsSpan | null;
  /** The turn's last cumulative usage report: the next turn's baseline. */
  usageTotal: TokenUsage | null;
}

/** Each completed item of the turn with its start and end, ordered by start. */
function itemRecords(turnEvents: readonly ThreadEventRow[]): ItemRecord[] {
  const starts = new Map<string, number>();
  const completed = new Map<string, { item: CompletedItem; endMs: number }>();
  for (const event of turnEvents) {
    if (event.type === "item/started" && !starts.has(event.data.item.id)) {
      starts.set(event.data.item.id, event.createdAt);
    }
    // Background tasks complete on the thread scope. Keep the ones this turn started.
    const finishesItem =
      event.type === "item/completed" ||
      (event.type === "item/backgroundTask/completed" && starts.has(event.data.item.id));
    if (finishesItem) {
      completed.set(event.data.item.id, { item: event.data.item, endMs: event.createdAt });
    }
  }
  return [...completed.entries()]
    .map(([itemId, { item, endMs }]) => ({
      item,
      endMs,
      startMs: Math.min(starts.get(itemId) ?? endMs, endMs),
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

interface LlmContext {
  steps: readonly LlmStep[];
  model: string | undefined;
  provider: string;
  fallbackName: string;
  usage: TokenUsage | null;
  /** The visible user prompt, or null when content is not exported. */
  userText: string | null;
  fullContent: boolean;
}

/** OpenAI-style messages: what the model read and what it answered. */
function llmMessages(step: LlmStep, index: number, context: LlmContext) {
  const previousCalls = context.steps[index - 1]?.calls ?? [];
  const input =
    index > 0
      ? previousCalls.map((call) => ({
          role: "tool",
          tool_call_id: call.item.id,
          content: bounded(itemOutput(call.item) ?? null),
        }))
      : context.userText === null
        ? []
        : [{ role: "user", content: context.userText }];
  const text = stepText(step);
  const output: Record<string, unknown> = { role: "assistant", content: bounded(text) };
  if (step.calls.length > 0) {
    output.tool_calls = step.calls.map((call) => ({
      id: call.item.id,
      type: "function",
      function: { name: itemName(call.item), arguments: bounded(itemInput(call.item) ?? {}) },
    }));
  }
  return {
    input: input.length > 0 ? input : undefined,
    output: text !== "" || step.calls.length > 0 ? [output] : undefined,
  };
}

function llmSpan(step: LlmStep, index: number, context: LlmContext): NeatlogsSpan {
  const { model, steps, usage } = context;
  const span: NeatlogsSpan = {
    name: model === undefined ? context.fallbackName : pricingModel(model),
    kind: "LLM",
    start: iso(step.startMs),
    end: iso(step.endMs),
    status: "OK",
    attributes: { "neatlogs.llm.provider": context.provider },
    metadata: { step: index + 1, stepCount: steps.length, callCount: step.calls.length },
  };
  if (model !== undefined) span.model = pricingModel(model);
  // BB has no per-request usage boundary for every provider, so the final
  // step carries the turn's usage once.
  if (usage !== null && index === steps.length - 1) {
    span.tokens = {
      prompt: usage.totalTokens - usage.outputTokens,
      completion: usage.outputTokens,
      total: usage.totalTokens,
    };
    span.attributes = {
      ...span.attributes,
      "neatlogs.llm.token_count.cache_read": usage.cacheReadInputTokens ?? 0,
      "neatlogs.llm.token_count.cache_write": usage.cacheWriteInputTokens ?? 0,
      "neatlogs.llm.token_count.reasoning": usage.reasoningOutputTokens,
    };
    span.metadata = { ...span.metadata, usageScope: "turn" };
  }
  if (context.fullContent) {
    const { input, output } = llmMessages(step, index, context);
    if (input !== undefined) span.input = input;
    if (output !== undefined) span.output = output;
  }
  return span;
}

interface PlacedSpan {
  span: NeatlogsSpan;
  startMs: number;
  endMs: number;
}

/**
 * Items nest under the call that spawned them (a subagent's work under its
 * delegation); everything else sits beside the LLM steps in time order.
 */
function nestSpans(
  llm: readonly PlacedSpan[],
  records: readonly ItemRecord[],
  fullContent: boolean,
): NeatlogsSpan[] {
  const nodes = new Map<string, PlacedSpan>();
  for (const record of records) {
    if (ITEM_SPANS[record.item.type] === null) continue;
    const { startMs, endMs } = record;
    nodes.set(record.item.id, { span: itemSpan(record, fullContent), startMs, endMs });
  }
  const topLevel = [...llm];
  for (const record of records) {
    const node = nodes.get(record.item.id);
    if (node === undefined) continue;
    const parentId = record.item.parentToolCallId;
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent === undefined) topLevel.push(node);
    else (parent.span.children ??= []).push(node.span);
  }
  // Codex reports a command's start and end together, so the command and the
  // round trip after it can share a start; the shorter one came first.
  return topLevel
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((node) => node.span);
}

function turnMetadata(
  thread: TraceThread,
  turnId: string,
  completion: EventOf<"turn/completed">,
  started: EventOf<"turn/started">,
  request: EventOf<"client/turn/requested"> | undefined,
  fallback: EventOf<"provider/modelFallback"> | undefined,
  fullContent: boolean,
): Record<string, MetadataValue> {
  const execution = request?.data.execution;
  const candidates: Record<string, MetadataValue | null | undefined> = {
    threadId: thread.id,
    turnId,
    turnStatus: completion.data.status,
    providerId: thread.providerId,
    projectId: thread.projectId,
    threadVisibility: thread.visibility,
    environmentId: thread.environmentId,
    parentThreadId: thread.parentThreadId,
    originPluginId: thread.originPluginId,
    model: execution?.model,
    fallbackModel: fallback?.data.fallbackModel,
    permissionMode: execution?.permissionMode,
    reasoningLevel: execution?.reasoningLevel,
    serviceTier: execution?.serviceTier,
    initiator: request?.data.initiator,
    turnSource: request?.data.source,
    senderThreadId: request?.data.senderThreadId,
    retryAttempt: request?.data.retryAttempt,
    providerThreadId: completion.data.providerThreadId ?? started.data.providerThreadId,
    // Titles are generated from the prompt, so they count as content.
    threadTitle: fullContent ? thread.title : null,
  };
  return Object.fromEntries(
    Object.entries(candidates).filter(
      (entry): entry is [string, MetadataValue] =>
        entry[1] !== null && entry[1] !== undefined && entry[1] !== "",
    ),
  );
}

function findEvent<T extends ThreadEventRow["type"]>(
  events: readonly ThreadEventRow[],
  type: T,
  from: "first" | "last",
): EventOf<T> | undefined {
  const matches = (event: ThreadEventRow): event is EventOf<T> => event.type === type;
  return from === "first" ? events.find(matches) : events.findLast(matches);
}

/** Build the Neatlogs trace for the turn that ends `events`. */
export function assembleTurnTrace({
  contentMode,
  events,
  thread,
  usageBaseline,
}: AssembleTurnTraceInput): AssembledTurn {
  const completion = findEvent(events, "turn/completed", "last");
  if (completion === undefined) throw new Error("cannot assemble an incomplete BB turn");

  const turnId = completion.scope.kind === "turn" ? completion.scope.turnId : completion.id;
  const turnEvents = events.filter(
    (event) => event.scope.kind !== "turn" || event.scope.turnId === turnId,
  );
  const usageTotal =
    findEvent(turnEvents, "thread/tokenUsage/updated", "last")?.data.tokenUsage.total ?? null;
  const started = findEvent(turnEvents, "turn/started", "first");
  if (started === undefined) return { trace: null, usageTotal };
  // A steer appends another request mid-turn; the first one started the turn.
  const request = findEvent(turnEvents, "client/turn/requested", "first");
  const fallback = findEvent(turnEvents, "provider/modelFallback", "last");

  // BB emits turn/started with the first provider item, so the request time
  // is the only signal for the first round trip's latency.
  const startMs = Math.min(request?.createdAt ?? started.createdAt, started.createdAt);
  const endMs = Math.max(startMs, completion.createdAt);

  const records = itemRecords(turnEvents);
  const itemIds = new Set(records.map((record) => record.item.id));
  const isNested = (record: ItemRecord): boolean =>
    record.item.parentToolCallId !== undefined && itemIds.has(record.item.parentToolCallId);
  const steps = groupLlmSteps(
    records.filter((record) => !isNested(record)),
    startMs,
  );
  if (steps.length === 0) steps.push({ startMs, endMs, items: [], calls: [] });

  const fullContent = contentMode === "full" && thread.visibility === "visible";
  const context: LlmContext = {
    steps,
    model: fallback?.data.fallbackModel ?? request?.data.execution.model,
    provider: LLM_PROVIDER_BY_BB_PROVIDER[thread.providerId] ?? thread.providerId,
    fallbackName: thread.providerId,
    usage: usageDelta(usageTotal, usageBaseline),
    userText: fullContent ? visibleUserText(turnEvents) : null,
    fullContent,
  };
  const llm = steps.map((step, index) => ({
    span: llmSpan(step, index, context),
    startMs: step.startMs,
    endMs: step.endMs,
  }));

  const failed = completion.data.status === "failed";
  const root: NeatlogsSpan = {
    name: WORKFLOW_NAME,
    kind: "WORKFLOW",
    start: iso(startMs),
    end: iso(endMs),
    status: failed ? "ERROR" : "OK",
    attributes: { "neatlogs.session.id": thread.id },
    metadata: turnMetadata(thread, turnId, completion, started, request, fallback, fullContent),
    children: nestSpans(llm, records, fullContent),
  };
  if (failed) root.error = "BB turn failed";
  if (context.userText !== null) root.input = bounded(context.userText);
  const finalText = fullContent ? steps.map(stepText).findLast((text) => text !== "") : undefined;
  if (finalText !== undefined) root.output = bounded(finalText);
  return { trace: root, usageTotal };
}
