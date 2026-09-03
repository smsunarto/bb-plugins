import { createHash } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LaminarConfig } from "../shared/settings.ts";

export type ThreadEventRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
type CompletedItem = Extract<ThreadEventRow, { type: "item/completed" }>["data"]["item"];

export interface TraceThread {
  archivedAt: number | null;
  createdAt?: number;
  deletedAt?: number | null;
  environmentId: string | null;
  id: string;
  originKind?: "fork" | null;
  originPluginId?: string | null;
  parentThreadId: string | null;
  projectId: string;
  providerId: string;
  sectionId?: string | null;
  sourceThreadId?: string | null;
  title?: string | null;
  titleFallback?: string | null;
  visibility: "hidden" | "visible";
}

interface OtlpAnyValue {
  arrayValue?: { values: OtlpAnyValue[] };
  boolValue?: boolean;
  intValue?: string;
  stringValue?: string;
}

interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  attributes: OtlpAttribute[];
  endTimeUnixNano: string;
  kind: number;
  name: string;
  parentSpanId?: string;
  spanId: string;
  startTimeUnixNano: string;
  status: { code: number; message?: string };
  traceId: string;
}

export interface ExportTraceServiceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

export interface AssembleTurnTraceInput {
  contentMode: "metadata" | "full";
  deploymentEnvironment: string;
  events: readonly ThreadEventRow[];
  historyRevision: number;
  thread: TraceThread;
}

const CONTENT_MAX_BYTES = 16_384;
const TEXT_MAX_CHARS = 12_000;
const TRACE_METADATA_PREFIX = "lmnr.association.properties.metadata";
const TOOL_ITEM_TYPES = new Set<CompletedItem["type"]>([
  "commandExecution",
  "fileChange",
  "webSearch",
  "webFetch",
  "imageView",
  "fileRead",
  "search",
  "toolCall",
  "backgroundTask",
]);

function stringAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function boolAttribute(key: string, value: boolean): OtlpAttribute {
  return { key, value: { boolValue: value } };
}

function stringArrayAttribute(key: string, values: readonly string[]): OtlpAttribute {
  return {
    key,
    value: { arrayValue: { values: values.map((value) => ({ stringValue: value })) } },
  };
}

function metadataAttribute(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === "string") return stringAttribute(`${TRACE_METADATA_PREFIX}.${key}`, value);
  if (typeof value === "number") return intAttribute(`${TRACE_METADATA_PREFIX}.${key}`, value);
  return boolAttribute(`${TRACE_METADATA_PREFIX}.${key}`, value);
}

function pushOptionalString(
  attributes: OtlpAttribute[],
  key: string,
  value: string | null | undefined,
): void {
  if (value !== null && value !== undefined && value !== "") {
    attributes.push(stringAttribute(key, value));
  }
}

function pushMetadata(
  attributes: OtlpAttribute[],
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value !== null && value !== undefined && value !== "") {
    attributes.push(metadataAttribute(key, value));
  }
}

function stableHex(kind: string, id: string, bytes: number): string {
  const hex = createHash("sha256")
    .update(`bb-laminar:v1:${kind}:${id}`)
    .digest("hex")
    .slice(0, bytes * 2);
  return /^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex;
}

function unixNano(epochMs: number): string {
  return (BigInt(Math.max(0, Math.trunc(epochMs))) * 1_000_000n).toString();
}

function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= CONTENT_MAX_BYTES) return encoded;

  let low = 0;
  let high = encoded.length;
  let best = JSON.stringify({ truncated: true, preview: "" });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ truncated: true, preview: encoded.slice(0, middle) });
    if (Buffer.byteLength(candidate) <= CONTENT_MAX_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function laminarMessageHash(role: "assistant" | "user", content: string): string {
  const canonical = canonicalJson({ role, content });
  return bytesToHex(blake3(new TextEncoder().encode(canonical)));
}

function itemStatus(item: CompletedItem): { code: number; message?: string } {
  if (
    ("status" in item && item.status === "failed") ||
    (item.type === "commandExecution" && item.exitCode !== undefined && item.exitCode !== 0) ||
    (item.type === "toolCall" && item.error !== undefined)
  ) {
    return { code: 2, message: "BB item failed" };
  }
  if ("status" in item && item.status !== "completed") return { code: 0 };
  return { code: 1 };
}

function itemName(item: CompletedItem): string {
  if (item.type === "toolCall") return item.tool;
  return `bb.agent.${item.type}`;
}

function itemMetadataAttributes(item: CompletedItem): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [];
  if ("presentation" in item && item.presentation !== undefined) {
    pushOptionalString(attributes, "bb.item.presentation.title", item.presentation.title);
    pushOptionalString(attributes, "bb.item.presentation.label", item.presentation.label.completed);
    if (item.presentation.suppress !== undefined) {
      attributes.push(boolAttribute("bb.item.presentation.suppressed", item.presentation.suppress));
    }
  }

  switch (item.type) {
    case "agentMessage":
      attributes.push(intAttribute("bb.item.output_chars", item.text.length));
      break;
    case "commandExecution":
      if (item.exitCode !== undefined) {
        attributes.push(intAttribute("bb.command.exit_code", item.exitCode));
      }
      if (item.durationMs !== undefined) {
        attributes.push(intAttribute("bb.item.reported_duration_ms", item.durationMs));
      }
      pushOptionalString(attributes, "bb.item.approval_status", item.approvalStatus);
      break;
    case "fileChange":
      attributes.push(intAttribute("bb.file_change.count", item.changes.length));
      pushOptionalString(attributes, "bb.item.approval_status", item.approvalStatus);
      break;
    case "webSearch":
      attributes.push(intAttribute("bb.web_search.query_count", item.queries.length));
      break;
    case "webFetch":
      attributes.push(boolAttribute("bb.web_fetch.has_result", item.resultText !== null));
      break;
    case "fileRead":
      attributes.push(stringAttribute("bb.file_read.status", item.status));
      break;
    case "search":
      attributes.push(stringAttribute("bb.search.mode", item.mode));
      attributes.push(stringAttribute("bb.search.status", item.status));
      break;
    case "toolCall":
      attributes.push(
        stringAttribute("gen_ai.operation.name", "execute_tool"),
        stringAttribute("gen_ai.tool.name", item.tool),
        stringAttribute("bb.tool.name", item.tool),
      );
      pushOptionalString(attributes, "bb.tool.server", item.server);
      if (item.durationMs !== undefined) {
        attributes.push(intAttribute("bb.item.reported_duration_ms", item.durationMs));
      }
      break;
    case "reasoning":
      attributes.push(
        intAttribute("bb.reasoning.content_part_count", item.content.length),
        intAttribute("bb.reasoning.summary_part_count", item.summary.length),
      );
      break;
    case "planSteps":
      attributes.push(intAttribute("bb.plan.step_count", item.steps.length));
      break;
    case "backgroundTask":
      attributes.push(
        stringAttribute("bb.background_task.task_type", item.taskType),
        stringAttribute("bb.background_task.task_status", item.taskStatus),
        boolAttribute("bb.background_task.skip_transcript", item.skipTranscript),
      );
      pushOptionalString(attributes, "bb.background_task.family_id", item.familyId);
      pushOptionalString(attributes, "bb.background_task.workflow_name", item.workflowName);
      if (item.usage !== undefined) {
        attributes.push(
          intAttribute("bb.background_task.duration_ms", item.usage.durationMs),
          intAttribute("bb.background_task.tool_uses", item.usage.toolUses),
          intAttribute("bb.background_task.total_tokens", item.usage.totalTokens),
        );
      }
      break;
    case "delegation":
      attributes.push(
        boolAttribute("bb.delegation.background", item.background),
        stringAttribute("bb.delegation.child_ref", item.childRef),
      );
      break;
    case "extension":
      attributes.push(stringAttribute("bb.extension.kind", item.kind));
      break;
    case "userMessage":
    case "plan":
    case "contextCompaction":
    case "imageView":
      break;
  }

  if ("truncation" in item && item.truncation !== undefined) {
    attributes.push(stringAttribute("bb.item.truncation", boundedJson(item.truncation)));
  }
  return attributes;
}

function fullItemAttributes(item: CompletedItem): OtlpAttribute[] {
  switch (item.type) {
    case "agentMessage":
      return [stringAttribute("lmnr.span.output", boundedJson({ text: item.text }))];
    case "commandExecution":
      return [
        stringAttribute("lmnr.span.input", boundedJson({ command: item.command, cwd: item.cwd })),
        stringAttribute(
          "lmnr.span.output",
          boundedJson({ exitCode: item.exitCode, output: item.aggregatedOutput }),
        ),
      ];
    case "fileChange":
      return [stringAttribute("lmnr.span.output", boundedJson({ changes: item.changes }))];
    case "webSearch":
      return [
        stringAttribute("lmnr.span.input", boundedJson({ queries: item.queries })),
        stringAttribute("lmnr.span.output", boundedJson({ result: item.resultText })),
      ];
    case "webFetch":
      return [
        stringAttribute(
          "lmnr.span.input",
          boundedJson({ url: item.url, pattern: item.pattern, prompt: item.prompt }),
        ),
        stringAttribute("lmnr.span.output", boundedJson({ result: item.resultText })),
      ];
    case "imageView":
      return [stringAttribute("lmnr.span.input", boundedJson({ path: item.path }))];
    case "fileRead":
      return [
        stringAttribute("lmnr.span.input", boundedJson({ path: item.path, command: item.cmd })),
      ];
    case "search":
      return [
        stringAttribute(
          "lmnr.span.input",
          boundedJson({ query: item.query, path: item.path, mode: item.mode, command: item.cmd }),
        ),
      ];
    case "toolCall":
      return [
        stringAttribute(
          "lmnr.span.input",
          boundedJson({ tool: item.tool, server: item.server, arguments: item.arguments }),
        ),
        stringAttribute("gen_ai.tool.call.arguments", boundedJson(item.arguments ?? {})),
        stringAttribute(
          "lmnr.span.output",
          boundedJson({ status: item.status, result: item.result, error: item.error }),
        ),
        stringAttribute(
          "gen_ai.tool.call.result",
          boundedJson({ status: item.status, result: item.result, error: item.error }),
        ),
      ];
    case "userMessage":
    case "reasoning":
    case "plan":
    case "planSteps":
    case "contextCompaction":
    case "backgroundTask":
    case "delegation":
    case "extension":
      return [];
  }
}

interface ItemRecord {
  completedAt: number;
  item: CompletedItem;
  seq: number;
  startMs: number;
}

/**
 * One provider round trip inside a BB turn. BB does not emit model request
 * boundaries, so a step is inferred from the item stream: it starts when the
 * previous step's tools have all finished and ends when its own first tool
 * starts. Steps without tools end when their last item completes.
 */
interface LlmStep {
  endMs: number;
  items: ItemRecord[];
  startMs: number;
  tools: ItemRecord[];
}

const GEN_AI_SYSTEM_BY_PROVIDER: Record<string, string> = {
  "claude-code": "anthropic",
  codex: "openai",
  nanocodex: "openai",
};

function genAiSystem(providerId: string): string {
  return GEN_AI_SYSTEM_BY_PROVIDER[providerId] ?? providerId;
}

/** BB model IDs may carry a context suffix such as `claude-opus-5[1m]`. */
function pricingModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

function isToolItem(item: CompletedItem): boolean {
  return TOOL_ITEM_TYPES.has(item.type);
}

function groupLlmSteps(records: readonly ItemRecord[], turnStartMs: number): LlmStep[] {
  const steps: LlmStep[] = [];
  let current: LlmStep | null = null;
  let nextStart = turnStartMs;

  const close = (step: LlmStep): void => {
    if (step.tools.length > 0) {
      step.endMs = Math.min(...step.tools.map((tool) => tool.startMs));
      nextStart = Math.max(...step.tools.map((tool) => tool.completedAt));
    } else {
      step.endMs = Math.max(...step.items.map((record) => record.completedAt));
      nextStart = step.endMs;
    }
    step.endMs = Math.max(step.startMs, step.endMs);
    steps.push(step);
  };

  for (const record of records) {
    const tool = isToolItem(record.item);
    const toolsDone =
      current !== null &&
      current.tools.length > 0 &&
      record.startMs >= Math.max(...current.tools.map((entry) => entry.completedAt));
    if (current !== null && current.tools.length > 0 && (!tool || toolsDone)) {
      close(current);
      current = null;
    }
    current ??= { startMs: nextStart, endMs: nextStart, items: [], tools: [] };
    if (tool) current.tools.push(record);
    else current.items.push(record);
  }
  if (current !== null) close(current);
  return steps;
}

function toolCallArguments(item: CompletedItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return { command: item.command, cwd: item.cwd };
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
      return { changes: item.changes.map((change) => change.path) };
    default:
      return {};
  }
}

function toolCallResponse(item: CompletedItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return { exitCode: item.exitCode, output: item.aggregatedOutput };
    case "toolCall":
      return { status: item.status, result: item.result, error: item.error };
    case "webSearch":
    case "webFetch":
      return { result: item.resultText };
    case "fileChange":
      return { changes: item.changes };
    default:
      return "status" in item ? { status: item.status } : {};
  }
}

function visibleUserText(events: readonly ThreadEventRow[]): string | null {
  const request = events.findLast(
    (event): event is Extract<ThreadEventRow, { type: "client/turn/requested" }> =>
      event.type === "client/turn/requested" && event.data.initiator === "user",
  );
  if (request === undefined) return null;
  const text = request.data.input
    .filter(
      (input): input is Extract<(typeof request.data.input)[number], { type: "text" }> =>
        input.type === "text" && input.visibility !== "agent-only",
    )
    .map((input) => input.text.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, TEXT_MAX_CHARS);
  return text === "" ? null : text;
}

function assistantText(items: readonly CompletedItem[]): string | null {
  const message = items.findLast((item) => item.type === "agentMessage");
  return message === undefined ? null : message.text.slice(0, TEXT_MAX_CHARS);
}

function chatMessages(role: "assistant" | "user", text: string): string {
  return boundedJson([{ role, content: text }]);
}

export function assembleTurnTrace({
  contentMode,
  deploymentEnvironment,
  events,
  historyRevision,
  thread,
}: AssembleTurnTraceInput): ExportTraceServiceRequest {
  const completion = events.findLast(
    (event): event is Extract<ThreadEventRow, { type: "turn/completed" }> =>
      event.type === "turn/completed",
  );
  if (completion === undefined) throw new Error("cannot assemble an incomplete BB turn");

  const turnId = completion.scope.kind === "turn" ? completion.scope.turnId : completion.id;
  const turnEvents = events.filter(
    (event) => event.scope.kind !== "turn" || event.scope.turnId === turnId,
  );
  const started = turnEvents.find(
    (event): event is Extract<ThreadEventRow, { type: "turn/started" }> =>
      event.type === "turn/started",
  );
  const startMs = Math.min(
    started?.createdAt ?? turnEvents[0]?.createdAt ?? completion.createdAt,
    completion.createdAt,
  );
  const traceId = stableHex("trace", turnId, 16);
  const rootSpanId = stableHex("turn-span", turnId, 8);

  const starts = new Map<string, number>();
  const completed = new Map<string, { item: CompletedItem; completedAt: number }>();
  for (const event of turnEvents) {
    if (event.type === "item/started" && !starts.has(event.data.item.id)) {
      starts.set(event.data.item.id, event.createdAt);
    }
    if (event.type === "item/completed") {
      completed.set(event.data.item.id, { item: event.data.item, completedAt: event.createdAt });
    }
    // Background tasks complete on the thread scope. Keep the ones this turn started.
    if (event.type === "item/backgroundTask/completed" && starts.has(event.data.item.id)) {
      completed.set(event.data.item.id, { item: event.data.item, completedAt: event.createdAt });
    }
  }
  const items = [...completed.values()].map(({ item }) => item);
  const itemIds = new Set(completed.keys());
  const records: ItemRecord[] = [...completed.entries()]
    .map(([itemId, record], seq) => ({
      completedAt: record.completedAt,
      item: record.item,
      seq,
      startMs: Math.min(starts.get(itemId) ?? record.completedAt, record.completedAt),
    }))
    .sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  const topLevel = records.filter(
    (record) =>
      record.item.parentToolCallId === undefined || !itemIds.has(record.item.parentToolCallId),
  );
  const steps = groupLlmSteps(topLevel, startMs);
  if (steps.length === 0) {
    steps.push({ startMs, endMs: completion.createdAt, items: [], tools: [] });
  }

  const request = turnEvents.findLast(
    (event): event is Extract<ThreadEventRow, { type: "client/turn/requested" }> =>
      event.type === "client/turn/requested",
  );
  const tokenUsage = turnEvents.findLast(
    (event): event is Extract<ThreadEventRow, { type: "thread/tokenUsage/updated" }> =>
      event.type === "thread/tokenUsage/updated",
  )?.data.tokenUsage.last;
  const fallback = turnEvents.findLast(
    (event): event is Extract<ThreadEventRow, { type: "provider/modelFallback" }> =>
      event.type === "provider/modelFallback",
  );
  const fullContent = contentMode === "full";

  const rootAttributes: OtlpAttribute[] = [
    stringAttribute("lmnr.span.type", "DEFAULT"),
    stringAttribute("lmnr.span.instrumentation_source", "bb-plugin-laminar"),
    stringAttribute("lmnr.association.properties.session_id", thread.id),
    stringAttribute("gen_ai.agent.name", "bb"),
    stringAttribute("bb.thread.id", thread.id),
    stringAttribute("bb.turn.id", turnId),
    stringAttribute("bb.turn.status", completion.data.status),
    stringAttribute("bb.provider.id", thread.providerId),
    stringAttribute("bb.project.id", thread.projectId),
    stringAttribute("bb.thread.visibility", thread.visibility),
    boolAttribute("bb.thread.archived", thread.archivedAt !== null),
    intAttribute("bb.history.revision", historyRevision),
    metadataAttribute("threadId", thread.id),
    metadataAttribute("turnId", turnId),
    metadataAttribute("turnStatus", completion.data.status),
    metadataAttribute("providerId", thread.providerId),
    metadataAttribute("projectId", thread.projectId),
    metadataAttribute("threadVisibility", thread.visibility),
    metadataAttribute("threadArchived", thread.archivedAt !== null),
    metadataAttribute("historyRevision", historyRevision),
  ];
  const threadTitle = thread.title ?? thread.titleFallback;
  pushOptionalString(rootAttributes, "bb.thread.title", threadTitle);
  pushMetadata(rootAttributes, "threadTitle", threadTitle);
  pushOptionalString(rootAttributes, "bb.thread.origin_kind", thread.originKind);
  pushMetadata(rootAttributes, "threadOriginKind", thread.originKind);
  pushOptionalString(rootAttributes, "bb.thread.origin_plugin_id", thread.originPluginId);
  pushMetadata(rootAttributes, "threadOriginPluginId", thread.originPluginId);
  pushOptionalString(rootAttributes, "bb.thread.source_id", thread.sourceThreadId);
  pushMetadata(rootAttributes, "sourceThreadId", thread.sourceThreadId);
  pushOptionalString(rootAttributes, "bb.thread.section_id", thread.sectionId);
  pushMetadata(rootAttributes, "sectionId", thread.sectionId);
  if (thread.environmentId !== null) {
    rootAttributes.push(stringAttribute("bb.environment.id", thread.environmentId));
    rootAttributes.push(metadataAttribute("environmentId", thread.environmentId));
  }
  if (thread.parentThreadId !== null) {
    rootAttributes.push(stringAttribute("bb.thread.parent_id", thread.parentThreadId));
    rootAttributes.push(metadataAttribute("parentThreadId", thread.parentThreadId));
  }
  if (request !== undefined) {
    rootAttributes.push(
      stringAttribute("bb.client.request_id", request.data.requestId),
      stringAttribute("bb.turn.initiator", request.data.initiator),
      stringAttribute("bb.turn.source", request.data.source),
      stringAttribute("bb.turn.target", request.data.target.kind),
      stringAttribute("bb.request.execution_source", request.data.execution.source),
      stringAttribute("bb.request.permission_mode", request.data.execution.permissionMode),
      stringAttribute("bb.request.reasoning_level", request.data.execution.reasoningLevel),
      stringAttribute("bb.request.service_tier", request.data.execution.serviceTier),
      stringAttribute("bb.request.model", request.data.execution.model),
      metadataAttribute("requestId", request.data.requestId),
      metadataAttribute("turnInitiator", request.data.initiator),
      metadataAttribute("turnSource", request.data.source),
      metadataAttribute("turnTarget", request.data.target.kind),
      metadataAttribute("model", request.data.execution.model),
      metadataAttribute("permissionMode", request.data.execution.permissionMode),
      metadataAttribute("reasoningLevel", request.data.execution.reasoningLevel),
      metadataAttribute("serviceTier", request.data.execution.serviceTier),
    );
    pushOptionalString(rootAttributes, "bb.turn.sender_thread_id", request.data.senderThreadId);
    pushMetadata(rootAttributes, "senderThreadId", request.data.senderThreadId);
    if (request.data.retryAttempt !== undefined) {
      rootAttributes.push(intAttribute("bb.turn.retry_attempt", request.data.retryAttempt));
      rootAttributes.push(metadataAttribute("retryAttempt", request.data.retryAttempt));
    }
    pushOptionalString(
      rootAttributes,
      "bb.turn.retry_of_request_id",
      request.data.retryOfRequestId,
    );
    pushMetadata(rootAttributes, "retryOfRequestId", request.data.retryOfRequestId);
    pushOptionalString(
      rootAttributes,
      "bb.turn.system_message_kind",
      request.data.systemMessageKind,
    );
    pushMetadata(rootAttributes, "systemMessageKind", request.data.systemMessageKind);
  }
  const providerThreadId = completion.data.providerThreadId ?? started?.data.providerThreadId;
  if (providerThreadId !== null && providerThreadId !== undefined) {
    rootAttributes.push(stringAttribute("bb.provider.thread_id", providerThreadId));
    rootAttributes.push(metadataAttribute("providerThreadId", providerThreadId));
  }
  pushOptionalString(
    rootAttributes,
    "bb.provider.checkpoint_id",
    completion.data.providerCheckpointId,
  );
  pushMetadata(rootAttributes, "providerCheckpointId", completion.data.providerCheckpointId);
  if (started?.data.parentToolCallId !== undefined) {
    rootAttributes.push(
      stringAttribute("bb.turn.parent_tool_call_id", started.data.parentToolCallId),
      metadataAttribute("parentToolCallId", started.data.parentToolCallId),
    );
  }
  if (fallback !== undefined) {
    rootAttributes.push(
      stringAttribute("bb.model.original", fallback.data.originalModel),
      stringAttribute("bb.model.fallback", fallback.data.fallbackModel),
      stringAttribute("bb.model.fallback_reason", fallback.data.reason),
      metadataAttribute("originalModel", fallback.data.originalModel),
      metadataAttribute("responseModel", fallback.data.fallbackModel),
      metadataAttribute("modelFallbackReason", fallback.data.reason),
    );
  }
  if (tokenUsage !== undefined) {
    rootAttributes.push(
      intAttribute("bb.usage.input_tokens", tokenUsage.inputTokens),
      intAttribute("bb.usage.output_tokens", tokenUsage.outputTokens),
      intAttribute("bb.usage.cached_input_tokens", tokenUsage.cachedInputTokens),
      intAttribute("bb.usage.reasoning_output_tokens", tokenUsage.reasoningOutputTokens),
      intAttribute("bb.usage.total_tokens", tokenUsage.totalTokens),
    );
  }
  const userInput = fullContent ? visibleUserText(turnEvents) : null;
  const finalOutput = fullContent ? assistantText(items) : null;
  if (userInput !== null) {
    rootAttributes.push(stringAttribute("lmnr.span.input", chatMessages("user", userInput)));
  }
  if (finalOutput !== null) {
    rootAttributes.push(
      stringAttribute("lmnr.span.output", chatMessages("assistant", finalOutput)),
    );
  }

  const root: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: "bb.agent.turn",
    kind: 1,
    startTimeUnixNano: unixNano(startMs),
    endTimeUnixNano: unixNano(completion.createdAt),
    attributes: rootAttributes,
    status:
      completion.data.status === "failed"
        ? { code: 2, message: "BB turn failed" }
        : completion.data.status === "completed"
          ? { code: 1 }
          : { code: 0 },
  };

  const stepSpanId = (index: number): string => stableHex("llm-span", `${turnId}:${index}`, 8);
  const stepOfItem = new Map<string, number>();
  steps.forEach((step, index) => {
    for (const record of step.items) stepOfItem.set(record.item.id, index);
  });
  const requestModel = request?.data.execution.model;
  const llmSpans = steps.map((step, index): OtlpSpan => {
    const attributes: OtlpAttribute[] = [
      stringAttribute("lmnr.span.type", "LLM"),
      stringAttribute("lmnr.span.instrumentation_source", "bb-plugin-laminar"),
      stringAttribute("gen_ai.operation.name", "chat"),
      stringAttribute("gen_ai.system", genAiSystem(thread.providerId)),
      stringAttribute("gen_ai.provider.name", genAiSystem(thread.providerId)),
      stringAttribute("bb.thread.id", thread.id),
      stringAttribute("bb.turn.id", turnId),
      stringAttribute("bb.provider.id", thread.providerId),
      stringAttribute("bb.project.id", thread.projectId),
      intAttribute("bb.llm.step", index + 1),
      intAttribute("bb.llm.step_count", steps.length),
      intAttribute("bb.llm.tool_count", step.tools.length),
      intAttribute("bb.history.revision", historyRevision),
    ];
    if (requestModel !== undefined) {
      attributes.push(
        stringAttribute("gen_ai.request.model", pricingModel(requestModel)),
        stringAttribute("bb.request.model", requestModel),
      );
    }
    if (request !== undefined) {
      attributes.push(
        stringAttribute("gen_ai.request.service_tier", request.data.execution.serviceTier),
      );
    }
    if (fallback !== undefined) {
      attributes.push(
        stringAttribute("gen_ai.response.model", pricingModel(fallback.data.fallbackModel)),
      );
    }
    if (providerThreadId !== null && providerThreadId !== undefined) {
      attributes.push(stringAttribute("bb.provider.thread_id", providerThreadId));
    }
    // BB reports usage once per turn, so the last step carries the turn total.
    if (tokenUsage !== undefined && index === steps.length - 1) {
      attributes.push(
        stringAttribute("bb.usage.scope", "turn"),
        intAttribute("gen_ai.usage.input_tokens", tokenUsage.inputTokens),
        intAttribute("gen_ai.usage.output_tokens", tokenUsage.outputTokens),
        intAttribute("gen_ai.usage.cache_read.input_tokens", tokenUsage.cachedInputTokens),
        intAttribute("gen_ai.usage.reasoning_tokens", tokenUsage.reasoningOutputTokens),
        intAttribute("gen_ai.usage.reasoning.output_tokens", tokenUsage.reasoningOutputTokens),
        intAttribute("llm.usage.total_tokens", tokenUsage.totalTokens),
      );
    }
    if (fullContent) {
      const inputParts: unknown[] = [];
      if (index === 0 && userInput !== null) {
        inputParts.push({ role: "user", parts: [{ type: "text", content: userInput }] });
      }
      const previous = steps[index - 1];
      if (previous !== undefined && previous.tools.length > 0) {
        inputParts.push({
          role: "tool",
          parts: previous.tools.map((tool) => ({
            type: "tool_call_response",
            id: tool.item.id,
            response: toolCallResponse(tool.item),
          })),
        });
      }
      const outputParts: unknown[] = [];
      for (const record of step.items) {
        if (record.item.type === "agentMessage") {
          outputParts.push({ type: "text", content: record.item.text.slice(0, TEXT_MAX_CHARS) });
        }
      }
      for (const tool of step.tools) {
        outputParts.push({
          type: "tool_call",
          id: tool.item.id,
          name: itemName(tool.item),
          arguments: toolCallArguments(tool.item),
        });
      }
      if (inputParts.length > 0) {
        attributes.push(stringAttribute("gen_ai.input.messages", boundedJson(inputParts)));
      }
      if (outputParts.length > 0) {
        attributes.push(
          stringAttribute(
            "gen_ai.output.messages",
            boundedJson([{ role: "assistant", parts: outputParts }]),
          ),
        );
      }
    }
    const failed = step.items.some((record) => itemStatus(record.item).code === 2);
    return {
      traceId,
      spanId: stepSpanId(index),
      parentSpanId: rootSpanId,
      name: "bb.agent.llm",
      kind: 1,
      startTimeUnixNano: unixNano(step.startMs),
      endTimeUnixNano: unixNano(step.endMs),
      attributes,
      status: failed ? { code: 2, message: "BB item failed" } : { code: 1 },
    };
  });

  const children = records.map((record): OtlpSpan => {
    const { item, completedAt, startMs: itemStartMs } = record;
    const itemId = item.id;
    const parentId = item.parentToolCallId;
    const attributes: OtlpAttribute[] = [
      stringAttribute("lmnr.span.type", isToolItem(item) ? "TOOL" : "DEFAULT"),
      stringAttribute("lmnr.span.instrumentation_source", "bb-plugin-laminar"),
      stringAttribute("bb.thread.id", thread.id),
      stringAttribute("bb.turn.id", turnId),
      stringAttribute("bb.item.id", itemId),
      stringAttribute("bb.item.type", item.type),
      stringAttribute("bb.provider.id", thread.providerId),
      stringAttribute("bb.project.id", thread.projectId),
      intAttribute("bb.history.revision", historyRevision),
    ];
    if (thread.environmentId !== null) {
      attributes.push(stringAttribute("bb.environment.id", thread.environmentId));
    }
    if (providerThreadId !== null && providerThreadId !== undefined) {
      attributes.push(stringAttribute("bb.provider.thread_id", providerThreadId));
    }
    if (parentId !== undefined) {
      attributes.push(stringAttribute("bb.item.parent_tool_call_id", parentId));
    }
    if ("status" in item) attributes.push(stringAttribute("bb.item.status", item.status));
    attributes.push(...itemMetadataAttributes(item));
    if (fullContent) attributes.push(...fullItemAttributes(item));
    const stepIndex = stepOfItem.get(itemId);
    const parentSpanId =
      parentId !== undefined && itemIds.has(parentId)
        ? stableHex("item-span", parentId, 8)
        : stepIndex !== undefined
          ? stepSpanId(stepIndex)
          : rootSpanId;
    return {
      traceId,
      spanId: stableHex("item-span", itemId, 8),
      parentSpanId,
      name: itemName(item),
      kind: 1,
      startTimeUnixNano: unixNano(itemStartMs),
      endTimeUnixNano: unixNano(completedAt),
      attributes,
      status: itemStatus(item),
    };
  });

  const traceIo: OtlpSpan[] = [];
  if (fullContent) {
    const input = visibleUserText(turnEvents);
    const output = assistantText(items);
    if (input !== null || output !== null) {
      const attributes = [boolAttribute("lmnr.internal.metadata_only", true)];
      if (input !== null) {
        attributes.push(stringAttribute("lmnr.internal.trace_input", input));
      }
      if (output !== null) {
        attributes.push(
          stringArrayAttribute("lmnr.internal.trace_output_hashes", [
            laminarMessageHash("assistant", output),
          ]),
        );
      }
      traceIo.push({
        traceId,
        spanId: stableHex("trace-io-span", turnId, 8),
        name: "bb.trace.io",
        kind: 1,
        startTimeUnixNano: unixNano(completion.createdAt),
        endTimeUnixNano: unixNano(completion.createdAt),
        attributes,
        status: { code: 1 },
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", "bb"),
            stringAttribute("service.namespace", "bb-plugin-laminar"),
            stringAttribute("service.version", "0.1.0"),
            stringAttribute("deployment.environment", deploymentEnvironment),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "bb-plugin-laminar", version: "0.1.0" },
            spans: [root, ...llmSpans, ...children, ...traceIo],
          },
        ],
      },
    ],
  };
}

export function traceIoOnly(request: ExportTraceServiceRequest): ExportTraceServiceRequest | null {
  const resourceSpans = request.resourceSpans
    .map((resourceSpan) => ({
      ...resourceSpan,
      scopeSpans: resourceSpan.scopeSpans
        .map((scopeSpan) => ({
          ...scopeSpan,
          spans: scopeSpan.spans.filter((span) =>
            span.attributes.some(
              (attribute) =>
                attribute.key === "lmnr.internal.metadata_only" &&
                attribute.value.boolValue === true,
            ),
          ),
        }))
        .filter((scopeSpan) => scopeSpan.spans.length > 0),
    }))
    .filter((resourceSpan) => resourceSpan.scopeSpans.length > 0);
  return resourceSpans.length === 0 ? null : { resourceSpans };
}

export function traceIoBackfill(
  request: ExportTraceServiceRequest,
): ExportTraceServiceRequest | null {
  const patch = traceIoOnly(request);
  if (patch === null) return null;

  const spans = request.resourceSpans.flatMap((resourceSpan) =>
    resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
  );
  const root = spans.find((span) => span.parentSpanId === undefined);
  const output = root?.attributes.find((attribute) => attribute.key === "lmnr.span.output");
  if (root === undefined || output?.value.stringValue === undefined) return patch;

  const carrier: OtlpSpan = {
    traceId: root.traceId,
    spanId: stableHex("trace-output-backfill-span", root.traceId, 8),
    parentSpanId: root.spanId,
    name: "bb.trace.output.backfill",
    kind: 1,
    startTimeUnixNano: root.endTimeUnixNano,
    endTimeUnixNano: root.endTimeUnixNano,
    attributes: [
      stringAttribute("lmnr.span.type", "LLM"),
      stringAttribute("lmnr.span.instrumentation_source", "bb-plugin-laminar"),
      boolAttribute("bb.backfill.content_carrier", true),
      output,
    ],
    status: { code: 1 },
  };
  patch.resourceSpans[0]?.scopeSpans[0]?.spans.unshift(carrier);
  return patch;
}

export class LaminarExportError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Laminar returned HTTP ${status}`);
    this.name = "LaminarExportError";
    this.status = status;
  }
}

export async function exportOtlpTrace(
  config: Pick<LaminarConfig, "apiKey" | "endpoint">,
  request: ExportTraceServiceRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new LaminarExportError(response.status);
  await response.body?.cancel();
}
