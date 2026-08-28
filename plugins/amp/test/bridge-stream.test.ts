// U2 gate: timeline.ts + project.ts against the REAL delta assembler from
// @get-bb/plugin-sdk/provider-bridge/testing. The bridge's captured JSON-RPC
// output is run through the exact translation the runtime performs, and the
// assertions are on canonical ThreadEvents.
import assert from "node:assert/strict";
import { describe, it, mock } from "bun:test";
import { experimental_createBridgeDeltaEventCollector } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { AmpEvent, AmpUsage } from "../src/bridge/events.ts";
import {
  projectAmpEvent,
  type OracleReports,
  type ProjectionContext,
} from "../src/bridge/project.ts";
import { startToolProxy } from "../src/bridge/tool-proxy.ts";
import {
  createThreadWriter,
  usageBreakdown,
  type ThreadWriter,
  type TurnScribe,
} from "../src/bridge/timeline.ts";

const THREAD_ID = "thr_stream_test";
const PROVIDER_THREAD_ID = "amp-deadbeefdeadbeefdeadbeef";

interface CapturedMessage {
  method?: string;
  params?: unknown;
}

function makeHarness() {
  const messages: CapturedMessage[] = [];
  const writer = createThreadWriter({
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    sessionRestorable: true,
    resetIdSpace: true,
    send: (message) => messages.push(message as CapturedMessage),
  });
  return { messages, writer };
}

function makeOracle() {
  const writes = new Map<string, string[]>();
  let nextReport = 0;
  const begin = mock<OracleReports["begin"]>((_question) => {
    nextReport += 1;
    const reportId = `report-${nextReport}`;
    writes.set(reportId, []);
    return { reportId, write: (text) => void writes.get(reportId)?.push(text) };
  });
  const finish = mock<OracleReports["finish"]>(() => {});
  const oracle: OracleReports = {
    begin,
    finish,
  };
  return { oracle, begin, finish, writes };
}

function makeContext(
  writer: ThreadWriter,
  scribe: TurnScribe,
  oracle: OracleReports,
): ProjectionContext {
  return {
    scribe,
    open: new Map(),
    rows: new Map(),
    oracleByCallId: new Map(),
    oracle,
    bbToolIds: new Set(["mcp__bb-bridge__my_tool"]),
    cwd: "/repo",
    addUsage: (usage: AmpUsage) => writer.addUsage(usageBreakdown(usage), null),
    raw: () => {},
  };
}

function assemble(messages: CapturedMessage[]) {
  const collector = experimental_createBridgeDeltaEventCollector("amp");
  const events = messages.flatMap((message) => collector.assembleMessage(message));
  return { collector, events };
}

function completedItems(events: unknown[]): Record<string, unknown>[] {
  return events
    .filter((event: any) => event.type === "item/completed")
    .map((event: any) => event.item);
}

describe("bridge stream (U2)", () => {
  it("assembles a full turn: identity, accept, items, usage, boundary", () => {
    const { messages, writer } = makeHarness();
    assert.equal(messages[0]?.method, "thread/identity");
    assert.deepEqual(messages[0]?.params, {
      threadId: THREAD_ID,
      providerThreadId: PROVIDER_THREAD_ID,
      sessionRestorable: true,
    });

    const scribe = writer.scribe();
    const { oracle, begin, finish, writes } = makeOracle();
    const ctx = makeContext(writer, scribe, oracle);
    scribe.accept("creq_abcdefgh23");
    const ampEvents: AmpEvent[] = [
      { kind: "init", tools: [], mcpServers: [{ name: "bb-bridge", status: "connected" }] },
      { kind: "thinking", text: "Pondering.", parent: null },
      { kind: "text", text: "Hello ", parent: null },
      { kind: "text", text: "world", parent: null },
      { kind: "toolStart", callId: "call-1", tool: "Bash", input: { cmd: "ls -la" }, parent: null },
      {
        kind: "toolEnd",
        callId: "call-1",
        output: { text: "file.txt", structured: { exitCode: 0 } },
        failed: false,
        parent: null,
      },
      {
        kind: "toolStart",
        callId: "call-2",
        tool: "Read",
        input: { path: "/repo/a.ts" },
        parent: null,
      },
      {
        kind: "toolEnd",
        callId: "call-2",
        output: { text: "contents", structured: null },
        failed: false,
        parent: null,
      },
      {
        kind: "toolStart",
        callId: "call-3",
        tool: "mcp__bb-bridge__my_tool",
        input: { arg: 1 },
        parent: null,
      },
      {
        kind: "toolEnd",
        callId: "call-3",
        output: { text: "ok", structured: null },
        failed: false,
        parent: null,
      },
      {
        kind: "toolStart",
        callId: "call-4",
        tool: "oracle",
        input: { task: "Why is the sky blue?\nGive detail." },
        parent: null,
      },
      {
        kind: "toolEnd",
        callId: "call-4",
        output: { text: "Rayleigh scattering.", structured: null },
        failed: false,
        parent: null,
      },
      {
        kind: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 10,
          cacheReadInputTokens: 40,
        },
      },
      { kind: "resultOk", denials: [] },
    ];
    for (const event of ampEvents) projectAmpEvent(event, ctx);
    scribe.settle("completed");

    const { collector, events } = assemble(messages);
    const types = events.map((event: any) => event.type);
    assert.equal(types[0], "turn/started");
    assert.equal(types[1], "turn/input/accepted");
    assert.equal(types[types.length - 1], "turn/completed");

    const items = completedItems(events);
    const byType = (type: string) => items.filter((item: any) => item.type === type);

    const [command] = byType("commandExecution") as any[];
    assert.ok(command, "command item assembled");
    assert.equal(command.command, "ls -la");
    assert.equal(command.cwd, "/repo");
    assert.equal(command.exitCode, 0);
    assert.equal(command.aggregatedOutput, "file.txt");

    const [fileRead] = byType("fileRead") as any[];
    assert.ok(fileRead, "fileRead item assembled");
    assert.equal(fileRead.path, "/repo/a.ts");

    const [toolCall] = byType("toolCall") as any[];
    assert.ok(toolCall, "bb tool row assembled");
    assert.equal(toolCall.server, "bb");
    assert.equal(collector.assembler.getBbItemId(THREAD_ID, "call-3"), toolCall.id);

    const [oracleItem] = byType("extension") as any[];
    assert.ok(oracleItem, "oracle extension item assembled");
    assert.equal(oracleItem.kind, "amp/oracle");
    assert.deepEqual(oracleItem.payload, {
      reportId: "report-1",
      question: "Why is the sky blue?",
    });
    assert.deepEqual(begin.mock.calls, [["Why is the sky blue?"]]);
    assert.deepEqual(finish.mock.calls, [["report-1", "completed"]]);
    assert.ok(
      (begin.mock.invocationCallOrder[0] ?? 0) < (finish.mock.invocationCallOrder[0] ?? 0),
      "oracle begins before it finishes",
    );
    assert.deepEqual(writes.get("report-1"), ["Rayleigh scattering."]);

    const [message] = byType("agentMessage") as any[];
    assert.ok(message, "agentMessage item assembled");
    assert.equal(message.text, "Hello world");
    assert.ok(byType("reasoning").length >= 1, "reasoning item assembled");

    // The assistant text settles before the first tool row opens.
    const messageCompletedIndex = events.findIndex(
      (event: any) => event.type === "item/completed" && event.item?.type === "agentMessage",
    );
    const commandStartedIndex = events.findIndex(
      (event: any) => event.type === "item/started" && event.item?.type === "commandExecution",
    );
    assert.ok(messageCompletedIndex >= 0 && commandStartedIndex >= 0);
    assert.ok(messageCompletedIndex < commandStartedIndex, "lanes flush before items");

    const usageEvent: any = events.find((event: any) => event.type === "thread/tokenUsage/updated");
    assert.ok(usageEvent, "usage event assembled");
    assert.deepEqual(usageEvent.tokenUsage.last, {
      inputTokens: 150,
      outputTokens: 50,
      cachedInputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 200,
    });
    assert.ok(events.some((event: any) => event.type === "thread/contextWindowUsage/updated"));
  });

  it("drains still-open items as interrupted and fails the oracle report", () => {
    const { messages, writer } = makeHarness();
    const scribe = writer.scribe();
    const { oracle, finish } = makeOracle();
    const ctx = makeContext(writer, scribe, oracle);
    projectAmpEvent(
      {
        kind: "toolStart",
        callId: "call-1",
        tool: "Bash",
        input: { cmd: "sleep 999" },
        parent: null,
      },
      ctx,
    );
    projectAmpEvent(
      {
        kind: "toolStart",
        callId: "call-2",
        tool: "oracle",
        input: { task: "Slow question" },
        parent: null,
      },
      ctx,
    );
    scribe.settle("interrupted");

    const { events } = assemble(messages);
    assert.equal(completedItems(events).length, 2);
    const last: any = events[events.length - 1];
    assert.equal(last.type, "turn/completed");
    assert.equal(last.status, "interrupted");
    assert.ok(
      finish.mock.calls.some(([reportId, status]) => reportId === "report-1" && status === "error"),
      "oracle report finished as error",
    );
  });

  it("resultError settles the turn as failed through provider.error", () => {
    const { messages, writer } = makeHarness();
    const scribe = writer.scribe();
    const { oracle } = makeOracle();
    const ctx = makeContext(writer, scribe, oracle);
    projectAmpEvent({ kind: "text", text: "Partial answer", parent: null }, ctx);
    projectAmpEvent(
      {
        kind: "resultError",
        subtype: "auth_required",
        message: "Please run amp login",
        denials: [],
      },
      ctx,
    );
    assert.equal(scribe.settled, true);

    // A late settle after fail() is silent — no second boundary.
    const messageCount = messages.length;
    scribe.settle("completed");
    writer.flush();
    assert.equal(messages.length, messageCount);

    const { events } = assemble(messages);
    const providerError: any = events.find((event: any) => event.type === "provider/error");
    assert.ok(providerError, "provider/error assembled");
    assert.equal(providerError.message, "Please run amp login");
    const last: any = events[events.length - 1];
    assert.equal(last.type, "turn/completed");
    assert.equal(last.status, "failed");
  });

  it("claims a zero-work turn", () => {
    const { messages, writer } = makeHarness();
    const scribe = writer.scribe();
    scribe.accept("creq_abcdefgh29");
    scribe.settle("completed");
    const { events } = assemble(messages);
    assert.deepEqual(
      events.map((event: any) => event.type),
      ["turn/started", "turn/input/accepted", "turn/completed"],
    );
  });

  it("shapes web, todo, and delegation tools", () => {
    const { messages, writer } = makeHarness();
    const scribe = writer.scribe();
    const { oracle } = makeOracle();
    const ctx = makeContext(writer, scribe, oracle);
    const done = { text: "", structured: null } as const;
    const ampEvents: AmpEvent[] = [
      {
        kind: "toolStart",
        callId: "web-1",
        tool: "web_search",
        input: { query: "amp" },
        parent: null,
      },
      { kind: "toolEnd", callId: "web-1", output: done, failed: false, parent: null },
      {
        kind: "toolStart",
        callId: "web-2",
        tool: "read_web_page",
        input: { url: "https://example.test/page" },
        parent: null,
      },
      { kind: "toolEnd", callId: "web-2", output: done, failed: false, parent: null },
      {
        kind: "toolStart",
        callId: "todo-1",
        tool: "todo_write",
        input: {
          todos: [
            { content: "a", status: "in-progress" },
            { content: "b", status: "completed" },
            { content: "c", status: "pending" },
          ],
        },
        parent: null,
      },
      { kind: "toolEnd", callId: "todo-1", output: done, failed: false, parent: null },
      {
        kind: "toolStart",
        callId: "task-1",
        tool: "Task",
        input: { description: "sub work" },
        parent: null,
      },
      {
        kind: "toolEnd",
        callId: "task-1",
        output: { text: "did the thing", structured: null },
        failed: false,
        parent: null,
      },
    ];
    for (const event of ampEvents) projectAmpEvent(event, ctx);
    scribe.settle("completed");

    const items = completedItems(assemble(messages).events);
    const byType = (type: string) => items.filter((item: any) => item.type === type);

    const [webSearch] = byType("webSearch") as any[];
    assert.ok(webSearch, "webSearch item assembled");
    assert.deepEqual(webSearch.queries, ["amp"]);

    const [webFetch] = byType("webFetch") as any[];
    assert.ok(webFetch, "webFetch item assembled");
    assert.equal(webFetch.url, "https://example.test/page");

    const [planSteps] = byType("planSteps") as any[];
    assert.ok(planSteps, "planSteps item assembled");
    assert.equal(planSteps.steps.length, 3);
    assert.equal(planSteps.steps[0].step, "a");
    assert.equal(planSteps.steps[0].status, "active");

    const [delegation] = byType("delegation") as any[];
    assert.ok(delegation, "delegation item assembled");
    assert.equal(delegation.childRef, "task-1");
    assert.equal(delegation.label, "sub work");
    assert.equal(delegation.summary, "did the thing");
  });

  it("warns when the bb-bridge MCP server is not connected", () => {
    const { messages, writer } = makeHarness();
    const scribe = writer.scribe();
    const { oracle } = makeOracle();
    const ctx = makeContext(writer, scribe, oracle);
    projectAmpEvent(
      { kind: "init", tools: [], mcpServers: [{ name: "bb-bridge", status: "failed" }] },
      ctx,
    );
    writer.flush();
    const { events } = assemble(messages);
    const warning: any = events.find((event: any) => event.type === "provider/warning");
    assert.ok(warning, "provider/warning assembled");
    assert.equal(warning.category, "config");
    assert.equal(warning.summary, "bb tools unavailable");
  });

  it("empty text and thinking emit nothing", () => {
    const { messages, writer } = makeHarness();
    const scribe = writer.scribe();
    writer.flush();
    const messageCount = messages.length;
    scribe.say("");
    scribe.think("");
    writer.flush();
    assert.equal(messages.length, messageCount);
  });

  it("writer notifications carry the thread id", () => {
    const { messages, writer } = makeHarness();
    writer.replaced({
      providerThreadId: null,
      reason: "amp session restarted",
      contextLost: false,
    });
    writer.recovery({ kind: "authRequired", retryable: true, message: "Run amp login" });
    writer.raw({ hello: 1 }, "noise");
    assert.deepEqual(
      messages.map((message) => message.method),
      ["thread/identity", "thread/delta", "session/replaced", "provider/recovery", "provider/raw"],
    );
    assert.deepEqual(messages[2]?.params, {
      threadId: THREAD_ID,
      providerThreadId: null,
      reason: "amp session restarted",
      contextLost: false,
    });
    assert.deepEqual(messages[3]?.params, {
      kind: "authRequired",
      retryable: true,
      message: "Run amp login",
      threadId: THREAD_ID,
    });
    assert.deepEqual(messages[4]?.params, {
      jsonrpc: "2.0",
      method: "amp/noise",
      params: { hello: 1 },
    });
  });
});

// U4 gate, row half: the ids a real `startToolProxy` mints are exactly the
// ids the projection maps to a `server: "bb"` tool row.
describe("bridge tool proxy stream (U4)", () => {
  it('proxy-minted tool ids drive the server "bb" row', async () => {
    const proxy = await startToolProxy({
      tools: [{ name: "my_tool", description: "A bb tool", inputSchema: { type: "object" } }],
      threadId: THREAD_ID,
      entryPath: "/artifact/host.js",
      callTool: () => Promise.resolve({ content: "" }),
    });
    try {
      const { messages, writer } = makeHarness();
      const scribe = writer.scribe();
      const { oracle } = makeOracle();
      const ctx: ProjectionContext = {
        scribe,
        open: new Map(),
        rows: new Map(),
        oracleByCallId: new Map(),
        oracle,
        bbToolIds: proxy.toolIds,
        cwd: "/repo",
        addUsage: () => {},
        raw: () => {},
      };
      const ampEvents: AmpEvent[] = [
        {
          kind: "toolStart",
          callId: "bb-1",
          tool: "mcp__bb-bridge__my_tool",
          input: { arg: 1 },
          parent: null,
        },
        {
          kind: "toolEnd",
          callId: "bb-1",
          output: { text: "ok", structured: null },
          failed: false,
          parent: null,
        },
      ];
      for (const event of ampEvents) projectAmpEvent(event, ctx);
      scribe.settle("completed");
      const items = completedItems(assemble(messages).events);
      const [toolCall] = items.filter((item: any) => item.type === "toolCall") as any[];
      assert.ok(toolCall, "bb tool row assembled");
      assert.equal(toolCall.server, "bb");
    } finally {
      proxy.close();
    }
  });
});
