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

function genAiMessages(role: "assistant" | "user", text: string): string {
  return boundedJson([{ role, parts: [{ type: "text", content: text }] }]);
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
  }
  const items = [...completed.values()].map(({ item }) => item);

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
    stringAttribute("lmnr.span.type", "LLM"),
    stringAttribute("lmnr.span.instrumentation_source", "bb-plugin-laminar"),
    stringAttribute("lmnr.association.properties.session_id", thread.id),
    stringAttribute("gen_ai.operation.name", "chat"),
    stringAttribute("gen_ai.system", thread.providerId),
    stringAttribute("gen_ai.provider.name", thread.providerId),
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
      stringAttribute("gen_ai.request.model", request.data.execution.model),
      stringAttribute("gen_ai.request.service_tier", request.data.execution.serviceTier),
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
      stringAttribute("gen_ai.response.model", fallback.data.fallbackModel),
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
      intAttribute("gen_ai.usage.input_tokens", tokenUsage.inputTokens),
      intAttribute("gen_ai.usage.output_tokens", tokenUsage.outputTokens),
      intAttribute("gen_ai.usage.cache_read.input_tokens", tokenUsage.cachedInputTokens),
      intAttribute("gen_ai.usage.reasoning_tokens", tokenUsage.reasoningOutputTokens),
      intAttribute("gen_ai.usage.reasoning.output_tokens", tokenUsage.reasoningOutputTokens),
      intAttribute("bb.usage.cached_input_tokens", tokenUsage.cachedInputTokens),
      intAttribute("bb.usage.reasoning_output_tokens", tokenUsage.reasoningOutputTokens),
      intAttribute("bb.usage.total_tokens", tokenUsage.totalTokens),
    );
  }
  if (fullContent) {
    const input = visibleUserText(turnEvents);
    const output = assistantText(items);
    if (input !== null) {
      rootAttributes.push(
        stringAttribute("lmnr.span.input", chatMessages("user", input)),
        stringAttribute("gen_ai.input.messages", genAiMessages("user", input)),
      );
    }
    if (output !== null) {
      rootAttributes.push(
        stringAttribute("lmnr.span.output", chatMessages("assistant", output)),
        stringAttribute("gen_ai.output.messages", genAiMessages("assistant", output)),
      );
    }
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

  const itemIds = new Set(completed.keys());
  const children = [...completed.entries()].map(([itemId, record]): OtlpSpan => {
    const { item, completedAt } = record;
    const itemStartMs = Math.min(starts.get(itemId) ?? completedAt, completedAt);
    const parentId = item.parentToolCallId;
    const attributes: OtlpAttribute[] = [
      stringAttribute("lmnr.span.type", TOOL_ITEM_TYPES.has(item.type) ? "TOOL" : "DEFAULT"),
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
    return {
      traceId,
      spanId: stableHex("item-span", itemId, 8),
      parentSpanId:
        parentId !== undefined && itemIds.has(parentId)
          ? stableHex("item-span", parentId, 8)
          : rootSpanId,
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
            spans: [root, ...children, ...traceIo],
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
