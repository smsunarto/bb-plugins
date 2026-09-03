import { afterEach, describe, expect, mock, test } from "bun:test";
import { exportToLaminar, traceIoOnly } from "./exporters/laminar.ts";
import { exportToLangfuse, langfuseRequest } from "./exporters/langfuse.ts";
import { ExportError } from "./exporters/otlp.ts";
import {
  assembleTurnTrace,
  type OtlpSpan,
  type ThreadEventRow,
  type TraceThread,
} from "./turn-trace.ts";

type EventOf<T extends ThreadEventRow["type"]> = Extract<ThreadEventRow, { type: T }>;

const thread: TraceThread = {
  archivedAt: null,
  createdAt: 100,
  deletedAt: null,
  environmentId: "environment-1",
  id: "thread-1",
  originKind: "fork",
  originPluginId: "plugin-1",
  parentThreadId: "parent-thread-1",
  projectId: "project-1",
  providerId: "provider-1",
  sectionId: "section-1",
  sourceThreadId: "source-thread-1",
  title: "Trace metadata audit",
  titleFallback: "Fallback title",
  visibility: "visible",
};

function event<T extends ThreadEventRow["type"]>(
  type: T,
  seq: number,
  data: EventOf<T>["data"],
  scope: EventOf<T>["scope"] = { kind: "turn", turnId: "turn-1" },
): EventOf<T> {
  return {
    id: `event-${seq}`,
    scope,
    threadId: thread.id,
    seq,
    createdAt: seq,
    type,
    data,
  } as EventOf<T>;
}

function requestEvent(): EventOf<"client/turn/requested"> {
  return event("client/turn/requested", 1, {
    direction: "outbound",
    execution: {
      model: "model-from-bb",
      permissionMode: "workspace-write",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    initiator: "user",
    input: [
      { type: "text", text: "visible prompt", mentions: [] },
      { type: "text", text: "agent-only prompt", mentions: [], visibility: "agent-only" },
      { type: "localFile", path: "/private/file", visibility: "agent-only" },
    ],
    request: { method: "turn/start", params: {} },
    requestId: "request-1",
    senderThreadId: null,
    source: "tell",
    target: { kind: "new-turn" },
  });
}

function turnEvents(): ThreadEventRow[] {
  return [
    requestEvent(),
    event("turn/started", 2, {
      providerThreadId: "provider-thread-1",
    }),
    event("item/completed", 3, {
      providerThreadId: "provider-thread-1",
      item: {
        id: "tool-parent",
        type: "toolCall",
        tool: "first-name",
        server: "server-secret",
        arguments: { password: "argument-secret" },
        result: { text: "result-secret" },
        status: "completed",
      },
    }),
    event("item/completed", 4, {
      providerThreadId: "provider-thread-1",
      item: {
        id: "tool-parent",
        type: "toolCall",
        tool: "final-name",
        server: "final-server",
        arguments: { value: "latest-argument" },
        result: { text: "latest-result" },
        durationMs: 17,
        status: "completed",
      },
    }),
    event("item/completed", 5, {
      providerThreadId: "provider-thread-1",
      item: {
        aggregatedOutput: "command-output-secret",
        approvalStatus: null,
        command: "echo command-secret",
        cwd: "/workspace",
        durationMs: 23,
        exitCode: 0,
        id: "tool-child",
        parentToolCallId: "tool-parent",
        status: "completed",
        type: "commandExecution",
      },
    }),
    event("item/completed", 6, {
      providerThreadId: "provider-thread-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        content: ["reasoning-secret"],
        summary: ["reasoning-summary-secret"],
      },
    }),
    event("item/completed", 7, {
      providerThreadId: "provider-thread-1",
      item: {
        id: "assistant-1",
        type: "agentMessage",
        text: "assistant answer",
      },
    }),
    event(
      "thread/tokenUsage/updated",
      8,
      {
        providerThreadId: "provider-thread-1",
        tokenUsage: {
          last: {
            cachedInputTokens: 2,
            inputTokens: 11,
            outputTokens: 7,
            reasoningOutputTokens: 3,
            totalTokens: 18,
          },
          modelContextWindow: 128_000,
          total: {
            cachedInputTokens: 200,
            inputTokens: 1_100,
            outputTokens: 700,
            reasoningOutputTokens: 300,
            totalTokens: 1_800,
          },
        },
      },
      { kind: "thread" },
    ),
    event("turn/completed", 9, {
      providerThreadId: "provider-thread-1",
      status: "completed",
    }),
  ];
}

function spans(mode: "metadata" | "full", events = turnEvents()) {
  return assembleTurnTrace({
    contentMode: mode,
    deploymentEnvironment: "test",
    events,
    historyRevision: 2,
    thread,
  }).resourceSpans[0]!.scopeSpans[0]!.spans;
}

function attributes(span: ReturnType<typeof spans>[number]): Record<string, unknown> {
  return Object.fromEntries(
    span.attributes.map((attribute) => [
      attribute.key,
      attribute.value.stringValue ??
        attribute.value.intValue ??
        attribute.value.boolValue ??
        attribute.value.arrayValue?.values.map(
          (value) => value.stringValue ?? value.intValue ?? value.boolValue,
        ),
    ]),
  );
}

describe("turn assembly", () => {
  test("deduplicates final item snapshots and keeps stable IDs, parents, and last-turn usage", () => {
    const first = spans("metadata");
    const second = spans("metadata");
    const root = first[0]!;
    const parent = first.find((span) => attributes(span)["bb.item.id"] === "tool-parent")!;
    const child = first.find((span) => attributes(span)["bb.item.id"] === "tool-child")!;

    const llm = first.filter((span) => attributes(span)["lmnr.span.type"] === "LLM");
    const lastLlm = llm.at(-1)!;

    expect(first).toHaveLength(7);
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(second[0]!.traceId).toBe(root.traceId);
    expect(second[0]!.spanId).toBe(root.spanId);
    expect(second.map((span) => span.spanId)).toEqual(first.map((span) => span.spanId));
    expect(parent.name).toBe("final-name");
    expect(parent.parentSpanId).toBe(root.spanId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(attributes(root)["lmnr.span.type"]).toBe("DEFAULT");
    expect(attributes(root)["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attributes(root)["bb.usage.total_tokens"]).toBe("18");
    expect(attributes(root)["bb.usage.cached_input_tokens"]).toBe("2");
    expect(llm).toHaveLength(2);
    expect(llm.map((span) => attributes(span)["bb.llm.step"])).toEqual(["1", "2"]);
    expect(llm[0]!.parentSpanId).toBe(root.spanId);
    expect(attributes(llm[0]!)["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attributes(lastLlm)["gen_ai.usage.input_tokens"]).toBe("11");
    expect(attributes(lastLlm)["gen_ai.usage.output_tokens"]).toBe("7");
    expect(attributes(lastLlm)["llm.usage.total_tokens"]).toBe("18");
    expect(attributes(lastLlm)["bb.usage.scope"]).toBe("turn");
    expect(attributes(lastLlm)["gen_ai.system"]).toBe("provider-1");
    expect(attributes(lastLlm)["gen_ai.provider.name"]).toBe("provider-1");
    expect(attributes(lastLlm)["gen_ai.operation.name"]).toBe("chat");
    expect(attributes(lastLlm)["gen_ai.request.model"]).toBe("model-from-bb");
    expect(attributes(lastLlm)["gen_ai.usage.cache_read.input_tokens"]).toBe("2");
    expect(attributes(lastLlm)["gen_ai.usage.reasoning_tokens"]).toBe("3");
    const reasoning = first.find((span) => attributes(span)["bb.item.id"] === "reasoning-1")!;
    const assistant = first.find((span) => attributes(span)["bb.item.id"] === "assistant-1")!;
    expect(reasoning.parentSpanId).toBe(lastLlm.spanId);
    expect(assistant.parentSpanId).toBe(lastLlm.spanId);
    expect(attributes(root)["lmnr.association.properties.session_id"]).toBe("thread-1");
    expect(attributes(root)["lmnr.association.properties.metadata.threadTitle"]).toBe(
      "Trace metadata audit",
    );
    expect(attributes(root)["lmnr.association.properties.metadata.permissionMode"]).toBe(
      "workspace-write",
    );
    expect(attributes(root)["lmnr.association.properties.metadata.reasoningLevel"]).toBe("medium");
    expect(attributes(root)["lmnr.association.properties.metadata.environmentId"]).toBe(
      "environment-1",
    );
    expect(attributes(root)["lmnr.association.properties.metadata.parentThreadId"]).toBe(
      "parent-thread-1",
    );
    expect(attributes(parent)["gen_ai.tool.name"]).toBe("final-name");
    expect(attributes(parent)["bb.tool.server"]).toBe("final-server");
    expect(attributes(parent)["bb.item.reported_duration_ms"]).toBe("17");
    expect(attributes(child)["bb.command.exit_code"]).toBe("0");
    expect(attributes(child)["bb.item.reported_duration_ms"]).toBe("23");
    expect(attributes(child)["bb.provider.id"]).toBe("provider-1");
    expect(parent.status.code).toBe(1);
    expect(child.status.code).toBe(1);
    expect(root.startTimeUnixNano).toBe("1000000");
    expect(root.endTimeUnixNano).toBe("9000000");
    expect(llm[0]!.startTimeUnixNano).toBe("1000000");
  });

  test("maps model fallback to Laminar response model and trace metadata", () => {
    const events = turnEvents();
    events.splice(
      -1,
      0,
      event("provider/modelFallback", 8.5, {
        fallbackModel: "fallback-model",
        message: "fallback detail",
        originalModel: "model-from-bb",
        providerThreadId: "provider-thread-1",
        reason: "provider",
      }),
    );

    const all = spans("metadata", events);
    const root = all[0]!;
    const llm = all.find((span) => attributes(span)["lmnr.span.type"] === "LLM")!;
    expect(attributes(llm)["gen_ai.response.model"]).toBe("fallback-model");
    expect(attributes(root)["bb.model.original"]).toBe("model-from-bb");
    expect(attributes(root)["lmnr.association.properties.metadata.responseModel"]).toBe(
      "fallback-model",
    );
    expect(JSON.stringify(root)).not.toContain("fallback detail");
  });

  test("metadata mode omits every content-bearing field", () => {
    const body = JSON.stringify(spans("metadata"));

    for (const secret of [
      "visible prompt",
      "agent-only prompt",
      "argument-secret",
      "latest-argument",
      "latest-result",
      "command-secret",
      "command-output-secret",
      "reasoning-secret",
      "reasoning-summary-secret",
      "assistant answer",
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  test("full mode exports bounded visible content but never reasoning or agent-only content", () => {
    const events = turnEvents();
    const command = events.find(
      (row): row is EventOf<"item/completed"> =>
        row.type === "item/completed" && row.data.item.type === "commandExecution",
    );
    if (command?.data.item.type !== "commandExecution") throw new Error("missing command fixture");
    command.data.item.aggregatedOutput = "x".repeat(30_000);

    const full = spans("full", events);
    const body = JSON.stringify(full);
    expect(body).toContain("visible prompt");
    expect(body).toContain("assistant answer");
    expect(body).toContain("latest-argument");
    expect(body).not.toContain("agent-only prompt");
    expect(body).not.toContain("/private/file");
    expect(body).not.toContain("reasoning-secret");
    expect(body).not.toContain("reasoning-summary-secret");

    const root = attributes(full[0]!);
    expect(JSON.parse(String(root["lmnr.span.input"]))).toEqual([
      { role: "user", content: "visible prompt" },
    ]);
    expect(JSON.parse(String(root["lmnr.span.output"]))).toEqual([
      { role: "assistant", content: "assistant answer" },
    ]);
    expect(root["gen_ai.input.messages"]).toBeUndefined();
    const llm = full
      .filter((span) => attributes(span)["lmnr.span.type"] === "LLM")
      .map((span) => attributes(span));
    expect(llm).toHaveLength(2);
    expect(JSON.parse(String(llm[0]!["gen_ai.input.messages"]))).toEqual([
      { role: "user", parts: [{ type: "text", content: "visible prompt" }] },
    ]);
    expect(JSON.parse(String(llm[0]!["gen_ai.output.messages"]))).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: "tool-parent",
            name: "final-name",
            arguments: { value: "latest-argument" },
          },
        ],
      },
    ]);
    expect(JSON.parse(String(llm[1]!["gen_ai.input.messages"]))).toEqual([
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "tool-parent",
            response: { status: "completed", result: { text: "latest-result" } },
          },
        ],
      },
    ]);
    expect(JSON.parse(String(llm[1]!["gen_ai.output.messages"]))).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "assistant answer" }] },
    ]);

    const traceIo = full.find((span) => attributes(span)["lmnr.internal.metadata_only"] === true);
    expect(traceIo).toBeDefined();
    if (traceIo === undefined) throw new Error("missing trace input/output metadata span");
    expect(traceIo.parentSpanId).toBeUndefined();
    expect(attributes(traceIo)["lmnr.internal.trace_input"]).toBe("visible prompt");
    expect(attributes(traceIo)["lmnr.internal.trace_output_hashes"]).toEqual([
      "62de9a778101786ad11155c8c3fb646ef17ec1aaadd5b1d72e2dfdd624f1485d",
    ]);

    const patch = traceIoOnly(
      assembleTurnTrace({
        contentMode: "full",
        deploymentEnvironment: "test",
        events,
        historyRevision: 2,
        thread,
      }),
    );
    expect(patch?.resourceSpans[0]?.scopeSpans[0]?.spans).toEqual([traceIo]);

    const tool = full.find((span) => attributes(span)["bb.item.id"] === "tool-parent")!;
    expect(JSON.parse(String(attributes(tool)["gen_ai.tool.call.arguments"]))).toEqual({
      value: "latest-argument",
    });
    expect(JSON.parse(String(attributes(tool)["gen_ai.tool.call.result"]))).toEqual({
      status: "completed",
      result: { text: "latest-result" },
    });

    const contentAttributes = full.flatMap((span) =>
      span.attributes.filter(
        (attribute) =>
          attribute.key === "lmnr.span.input" ||
          attribute.key === "lmnr.span.output" ||
          attribute.key === "gen_ai.input.messages" ||
          attribute.key === "gen_ai.output.messages",
      ),
    );
    for (const attribute of contentAttributes) {
      if (attribute.value.stringValue === undefined) continue;
      expect(() => JSON.parse(attribute.value.stringValue!)).not.toThrow();
      expect(Buffer.byteLength(attribute.value.stringValue)).toBeLessThanOrEqual(16_384);
    }
  });

  test("full mode omits agent-only prompts but retains visible-thread output", () => {
    const events = turnEvents();
    const request = events.find(
      (row): row is EventOf<"client/turn/requested"> => row.type === "client/turn/requested",
    );
    if (request === undefined) throw new Error("missing request fixture");
    request.data.initiator = "agent";

    const body = JSON.stringify(spans("full", events));
    expect(body).not.toContain("visible prompt");
    expect(body).toContain("assistant answer");
    const patch = traceIoOnly(
      assembleTurnTrace({
        contentMode: "full",
        deploymentEnvironment: "test",
        events,
        historyRevision: 2,
        thread,
      }),
    );
    const traceIo = patch?.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(traceIo).toBeDefined();
    if (traceIo === undefined) throw new Error("missing trace output metadata span");
    expect(attributes(traceIo)["lmnr.internal.trace_input"]).toBeUndefined();
    expect(attributes(traceIo)["lmnr.internal.trace_output_hashes"]).toEqual([
      "62de9a778101786ad11155c8c3fb646ef17ec1aaadd5b1d72e2dfdd624f1485d",
    ]);
  });

  test("splits provider round trips on tool completion and keeps parallel tools together", () => {
    const startedAt = (id: string, type: "commandExecution" | "reasoning", at: number) =>
      event("item/started", at, {
        providerThreadId: "provider-thread-1",
        item:
          type === "reasoning"
            ? { id, type, content: [], summary: [] }
            : {
                aggregatedOutput: "",
                approvalStatus: null,
                command: `run ${id}`,
                cwd: "/workspace",
                exitCode: undefined,
                id,
                status: "pending",
                type,
              },
      });
    const done = (id: string, type: "commandExecution" | "reasoning", at: number) =>
      event("item/completed", at, {
        providerThreadId: "provider-thread-1",
        item:
          type === "reasoning"
            ? { id, type, content: [], summary: [] }
            : {
                aggregatedOutput: "ok",
                approvalStatus: null,
                command: `run ${id}`,
                cwd: "/workspace",
                exitCode: 0,
                id,
                status: "completed",
                type,
              },
      });
    const events: ThreadEventRow[] = [
      requestEvent(),
      event("turn/started", 10, { providerThreadId: "provider-thread-1" }),
      startedAt("think-1", "reasoning", 12),
      done("think-1", "reasoning", 20),
      // Two tools from one response: the second starts before the first finishes.
      startedAt("cmd-a", "commandExecution", 21),
      startedAt("cmd-b", "commandExecution", 22),
      done("cmd-a", "commandExecution", 30),
      done("cmd-b", "commandExecution", 35),
      // A tool from a later response starts after every earlier tool finished.
      startedAt("cmd-c", "commandExecution", 40),
      done("cmd-c", "commandExecution", 45),
      startedAt("think-2", "reasoning", 50),
      done("think-2", "reasoning", 55),
      event("item/completed", 56, {
        providerThreadId: "provider-thread-1",
        item: { id: "answer", type: "agentMessage", text: "done" },
      }),
      event("turn/completed", 60, { providerThreadId: "provider-thread-1", status: "completed" }),
    ];

    const all = spans("metadata", events);
    const llm = all.filter((span) => attributes(span)["lmnr.span.type"] === "LLM");
    const window = (span: OtlpSpan) => [
      Number(BigInt(span.startTimeUnixNano) / 1_000_000n),
      Number(BigInt(span.endTimeUnixNano) / 1_000_000n),
    ];

    expect(llm.map(window)).toEqual([
      [1, 21],
      [35, 40],
      [45, 56],
    ]);
    expect(llm.map((span) => attributes(span)["bb.llm.tool_count"])).toEqual(["2", "1", "0"]);
    const byItem = (id: string) => all.find((span) => attributes(span)["bb.item.id"] === id)!;
    expect(byItem("think-1").parentSpanId).toBe(llm[0]!.spanId);
    expect(byItem("cmd-a").parentSpanId).toBe(all[0]!.spanId);
    expect(byItem("cmd-c").parentSpanId).toBe(all[0]!.spanId);
    expect(byItem("think-2").parentSpanId).toBe(llm[2]!.spanId);
    expect(byItem("answer").parentSpanId).toBe(llm[2]!.spanId);
    expect(window(byItem("cmd-b"))).toEqual([22, 35]);
  });

  test("exports background tasks completed on the thread scope under their command", () => {
    const task = {
      description: "Typecheck",
      familyId: "family-1",
      id: "task-1",
      parentToolCallId: "cmd-1",
      skipTranscript: false,
      status: "completed" as const,
      taskStatus: "completed" as const,
      taskType: "local_bash",
      type: "backgroundTask" as const,
    };
    const events: ThreadEventRow[] = [
      requestEvent(),
      event("turn/started", 10, { providerThreadId: "provider-thread-1" }),
      event("item/started", 11, {
        providerThreadId: "provider-thread-1",
        item: {
          aggregatedOutput: "",
          approvalStatus: null,
          command: "bun tsc",
          cwd: "/workspace",
          id: "cmd-1",
          status: "pending",
          type: "commandExecution",
        },
      }),
      event("item/started", 12, {
        providerThreadId: "provider-thread-1",
        item: { ...task, status: "pending", taskStatus: "running" as const },
      }),
      event("item/completed", 13, {
        providerThreadId: "provider-thread-1",
        item: {
          aggregatedOutput: "started",
          approvalStatus: null,
          command: "bun tsc",
          cwd: "/workspace",
          exitCode: 0,
          id: "cmd-1",
          status: "completed",
          type: "commandExecution",
        },
      }),
      event(
        "item/backgroundTask/completed",
        14,
        { providerThreadId: "provider-thread-1", item: task },
        { kind: "thread" },
      ),
      event(
        "item/backgroundTask/completed",
        15,
        { providerThreadId: "provider-thread-1", item: { ...task, id: "task-from-earlier-turn" } },
        { kind: "thread" },
      ),
      event("turn/completed", 20, { providerThreadId: "provider-thread-1", status: "completed" }),
    ];

    const all = spans("metadata", events);
    const command = all.find((span) => attributes(span)["bb.item.id"] === "cmd-1")!;
    const background = all.find((span) => attributes(span)["bb.item.id"] === "task-1")!;
    expect(background.parentSpanId).toBe(command.spanId);
    expect(background.startTimeUnixNano).toBe("12000000");
    expect(background.endTimeUnixNano).toBe("14000000");
    expect(attributes(background)["lmnr.span.type"]).toBe("TOOL");
    expect(all.some((span) => attributes(span)["bb.item.id"] === "task-from-earlier-turn")).toBe(
      false,
    );
  });

  test("maps BB providers and model suffixes onto Laminar pricing keys", () => {
    const events = turnEvents();
    const request = events[0];
    if (request?.type !== "client/turn/requested") throw new Error("missing request fixture");
    request.data.execution.model = "claude-opus-5[1m]";

    const llm = assembleTurnTrace({
      contentMode: "metadata",
      deploymentEnvironment: "test",
      events,
      historyRevision: 0,
      thread: { ...thread, providerId: "claude-code" },
    })
      .resourceSpans[0]!.scopeSpans[0]!.spans.filter(
        (span) => attributes(span)["lmnr.span.type"] === "LLM",
      )
      .map((span) => attributes(span));

    expect(llm[0]!["gen_ai.system"]).toBe("anthropic");
    expect(llm[0]!["gen_ai.request.model"]).toBe("claude-opus-5");
    expect(llm[0]!["bb.request.model"]).toBe("claude-opus-5[1m]");
  });

  test("uses native OTLP status codes for completed, interrupted, and failed turns", () => {
    const completed = spans("metadata")[0]!;
    const interruptedEvents = turnEvents();
    const interrupted = interruptedEvents.at(-1);
    if (interrupted?.type !== "turn/completed") throw new Error("missing completion fixture");
    interrupted.data.status = "interrupted";
    const failedEvents = turnEvents();
    const failed = failedEvents.at(-1);
    if (failed?.type !== "turn/completed") throw new Error("missing completion fixture");
    failed.data.status = "failed";

    expect(completed.status.code).toBe(1);
    expect(spans("metadata", interruptedEvents)[0]!.status.code).toBe(0);
    expect(spans("metadata", failedEvents)[0]!.status.code).toBe(2);
  });
});

describe("Langfuse mapping", () => {
  function langfuseSpans(mode: "metadata" | "full", events = turnEvents()) {
    const mapped = langfuseRequest(
      assembleTurnTrace({
        contentMode: mode,
        deploymentEnvironment: "test",
        events,
        historyRevision: 2,
        thread,
      }),
    );
    if (mapped === null) throw new Error("missing Langfuse request");
    return mapped.resourceSpans[0]!.scopeSpans[0]!.spans;
  }

  test("types observations, sets session and environment, and drops Laminar-only keys", () => {
    const all = langfuseSpans("full");
    const root = attributes(all[0]!);
    const keys = all.flatMap((span) => span.attributes.map((attribute) => attribute.key));

    expect(root["langfuse.observation.type"]).toBe("agent");
    expect(root["langfuse.session.id"]).toBe("thread-1");
    expect(root["langfuse.environment"]).toBe("test");
    expect(root["langfuse.trace.tags"]).toEqual(["provider:provider-1", "visibility:visible"]);
    expect(root["langfuse.trace.metadata.threadTitle"]).toBe("Trace metadata audit");
    expect(root["langfuse.trace.metadata.historyRevision"]).toBe("2");
    expect(JSON.parse(String(root["langfuse.observation.input"]))).toEqual([
      { role: "user", content: "visible prompt" },
    ]);
    expect(JSON.parse(String(root["langfuse.observation.output"]))).toEqual([
      { role: "assistant", content: "assistant answer" },
    ]);
    expect(keys.some((key) => key.startsWith("lmnr."))).toBe(false);
    expect(keys.some((key) => key.startsWith("gen_ai.usage."))).toBe(false);
    expect(keys).not.toContain("gen_ai.input.messages");
    expect(all.some((span) => span.name === "bb.trace.io")).toBe(false);
    expect(all.map((span) => [span.name, attributes(span)["langfuse.observation.type"]])).toEqual([
      ["bb.agent.turn", "agent"],
      ["bb.agent.llm", "generation"],
      ["bb.agent.llm", "generation"],
      ["final-name", "tool"],
      ["bb.agent.commandExecution", "tool"],
      ["bb.agent.reasoning", "span"],
      ["bb.agent.agentMessage", "span"],
    ]);
  });

  test("emits generations with exclusive usage buckets and OpenAI-format tool calls", () => {
    const all = langfuseSpans("full");
    const generations = all
      .filter((span) => attributes(span)["langfuse.observation.type"] === "generation")
      .map((span) => attributes(span));
    const last = generations.at(-1)!;

    expect(last["langfuse.observation.model.name"]).toBe("model-from-bb");
    expect(JSON.parse(String(last["langfuse.observation.usage_details"]))).toEqual({
      input: 11,
      output: 4,
      input_cached_tokens: 2,
      output_reasoning_tokens: 3,
      total: 20,
    });
    expect(JSON.parse(String(generations[0]!["langfuse.observation.usage_details"]))).toEqual({
      input: 0,
      output: 0,
      total: 0,
    });
    expect(generations[0]!["langfuse.observation.metadata.usageScope"]).toBe(
      "counted-on-last-step",
    );
    expect(JSON.parse(String(generations[0]!["langfuse.observation.input"]))).toEqual([
      { role: "user", content: "visible prompt" },
    ]);
    expect(JSON.parse(String(generations[0]!["langfuse.observation.output"]))).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tool-parent",
            type: "function",
            function: { name: "final-name", arguments: '{"value":"latest-argument"}' },
          },
        ],
      },
    ]);
    expect(JSON.parse(String(generations[1]!["langfuse.observation.input"]))).toEqual([
      {
        role: "tool",
        tool_call_id: "tool-parent",
        content: '{"status":"completed","result":{"text":"latest-result"}}',
      },
    ]);
    expect(JSON.parse(String(generations[1]!["langfuse.observation.output"]))).toEqual([
      { role: "assistant", content: "assistant answer" },
    ]);
    const tool = all.find((span) => attributes(span)["bb.item.id"] === "tool-parent")!;
    expect(JSON.parse(String(attributes(tool)["langfuse.observation.input"]))).toEqual({
      value: "latest-argument",
    });
  });

  test("metadata mode keeps Langfuse content fields empty", () => {
    const body = JSON.stringify(langfuseSpans("metadata"));
    expect(body).not.toContain("langfuse.observation.input");
    expect(body).not.toContain("langfuse.observation.output");
    expect(body).not.toContain("visible prompt");
    expect(body).not.toContain("assistant answer");
  });
});

describe("OTLP HTTP export", () => {
  const servers: Bun.Server<unknown>[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  test("posts the exact path, headers, and lowerCamelCase OTLP JSON body", async () => {
    let receivedBody: unknown;
    const requests = mock(async (request: Request) => {
      receivedBody = await request.json();
      return Response.json({ ok: true });
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: requests });
    servers.push(server);
    const body = assembleTurnTrace({
      contentMode: "metadata",
      deploymentEnvironment: "test",
      events: turnEvents(),
      historyRevision: 0,
      thread,
    });

    await exportToLaminar(
      { apiKey: "test-api-key", endpoint: new URL("/v1/traces", server.url).toString() },
      body,
    );

    expect(requests).toHaveBeenCalledTimes(1);
    const request = requests.mock.calls[0]![0];
    expect(new URL(request.url).pathname).toBe("/v1/traces");
    expect(request.headers.get("authorization")).toBe("Bearer test-api-key");
    expect(request.headers.get("content-type")).toBe("application/json");
    const json = receivedBody as typeof body;
    expect(json).toEqual(body);
    const root = json.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("missing root span");
    expect(root.kind).toBe(1);
    expect(root.status.code).toBe(1);
    expect("trace_id" in root).toBe(false);
    expect(json.resourceSpans[0]!.resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "bb" } },
        { key: "service.version", value: { stringValue: "0.1.0" } },
        { key: "deployment.environment", value: { stringValue: "test" } },
      ]),
    );
  });

  test("posts to the Langfuse OTLP path with basic auth and the v4 ingestion header", async () => {
    let received: { headers: Headers; pathname: string } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        received = { headers: request.headers, pathname: new URL(request.url).pathname };
        return Response.json({ ok: true });
      },
    });
    servers.push(server);

    await exportToLangfuse(
      {
        baseUrl: server.url.toString().replace(/\/$/, ""),
        publicKey: "pk-lf-1",
        secretKey: "sk-lf-1",
      },
      { resourceSpans: [] },
    );

    expect(received).toBeDefined();
    if (received === undefined) throw new Error("missing request");
    expect(received.pathname).toBe("/api/public/otel/v1/traces");
    expect(received.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`,
    );
    expect(received.headers.get("x-langfuse-ingestion-version")).toBe("4");
    expect(received.headers.get("content-type")).toBe("application/json");
  });

  test("reports non-success HTTP status without including response data", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("do not expose this", { status: 429 }),
    });
    servers.push(server);

    await expect(
      exportToLaminar(
        { apiKey: "test-api-key", endpoint: new URL("/v1/traces", server.url).toString() },
        { resourceSpans: [] },
      ),
    ).rejects.toEqual(
      expect.objectContaining({ backend: "laminar", status: 429 } satisfies Partial<ExportError>),
    );
  });
});
