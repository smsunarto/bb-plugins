// Assembled layer: timeline.ts + project.ts against the REAL delta assembler
// from @get-bb/plugin-sdk/provider-bridge/testing. The bridge's captured
// JSON-RPC output runs through the exact translation the runtime performs,
// and the assertions are on canonical ThreadEvents.
//
// The load-bearing scenario is two turns in one session reusing the same
// nanocodex-native ids (`call-1`, `msg-1`): the runtime assembler maps
// providerItemId -> bbItemId per THREAD and never clears that map, so a key
// that repeats across turns would silently alias two items. The scribe's
// ordinal prefix is what prevents that, and only this layer can see it work.
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type {
  ClientTurnRequestId,
  ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { parseEventLine, type NanocodexEnvelope } from "../src/bridge/events.ts";
import { createTurnProjector } from "../src/bridge/project.ts";
import { createThreadWriter, type ThreadWriter } from "../src/bridge/timeline.ts";

const THREAD_ID = "thr_stream_test";
const PROVIDER_THREAD_ID = "nanocodex-deadbeefdeadbeefdeadbeef";

interface CapturedMessage {
  method?: string;
  params?: unknown;
}

function makeHarness() {
  const messages: CapturedMessage[] = [];
  const writer = createThreadWriter({
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    send: (message) => messages.push(message as CapturedMessage),
  });
  return { messages, writer };
}

let seq = 0;
function envelope(type: string, payload: unknown, requestId: string): NanocodexEnvelope {
  seq += 1;
  const parsed = parseEventLine(
    JSON.stringify({ protocol_version: 1, request_id: requestId, seq, type, payload }),
  );
  assert.ok(parsed, `parseEventLine rejected a ${type} envelope`);
  return parsed;
}

const CALL_USAGE = {
  input_tokens: 13466,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  total_tokens: 13471,
};

const RUN_USAGE = {
  input_tokens: 13466,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0,
  total_tokens: 13471,
};

const WARMUP_USAGE = {
  input_tokens: 9742,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 9742,
};

/**
 * One full turn with intentionally turn-agnostic native ids. `requestId`
 * varies per turn (it is nanocodex's per-run session uuid); `call-1` and
 * `msg-1` do not, which is the aliasing trap under test.
 */
function runTurn(writer: ThreadWriter, ordinal: number, creq: ClientTurnRequestId): void {
  const requestId = `run-uuid-${ordinal}`;
  const scribe = writer.scribe({ ordinal, clientRequestIds: [creq] });
  const projector = createTurnProjector({
    scribe,
    ordinal,
    userText: "do work",
    promptBytes: 100,
    clientRequestIds: [creq],
    addUsage: (last: ThreadEventTokenUsageBreakdown, promptTokens: number | null) =>
      writer.addUsage(last, promptTokens),
    raw: () => {},
  });
  const events = [
    envelope("run.started", { mode: "openai_model", model: "gpt-5.6-sol" }, requestId),
    envelope(
      "tool.call",
      { call_id: "call-1", tool: "exec", arguments: 'await tools.exec_command({cmd:"ls"});', model_call_index: 1 },
      requestId,
    ),
    envelope(
      "tool.result",
      { call_id: "call-1", tool: "exec", status: "completed", duration_ns: 1000, result: "ok" },
      requestId,
    ),
    envelope(
      "assistant.message",
      { model_call_index: 1, item_id: "msg-1", phase: "final_answer", text: `answer ${ordinal}` },
      requestId,
    ),
    envelope(
      "model.call.completed",
      { call_index: 1, model: "gpt-5.6-sol", status: "completed", usage: CALL_USAGE },
      requestId,
    ),
    envelope(
      "run.completed",
      { status: "completed", model: "gpt-5.6-sol", usage: RUN_USAGE, warmup_usage: WARMUP_USAGE },
      requestId,
    ),
  ];
  for (const event of events) projector.consume(event);
  assert.equal(scribe.settled, true, `turn ${ordinal} settled through run.completed`);
}

function assemble(messages: CapturedMessage[]) {
  const collector = createBridgeDeltaEventCollector("nanocodex");
  return messages.flatMap((message) => collector.assembleMessage(message));
}

describe("bridge stream", () => {
  it("two turns reusing nanocodex-native ids assemble with no item id repeats", () => {
    const { messages, writer } = makeHarness();
    assert.equal(messages[0]?.method, "thread/identity");

    runTurn(writer, 0, "creq_turnaaaa22" as ClientTurnRequestId);
    runTurn(writer, 1, "creq_turnbbbb23" as ClientTurnRequestId);

    const events = assemble(messages) as any[];

    const completions = events.filter((event) => event.type === "turn/completed");
    assert.equal(completions.length, 2, "both turns settled");
    assert.deepEqual(
      completions.map((event) => event.status),
      ["completed", "completed"],
    );
    // The boundary's checkpoint id is the ledger ordinal — the fork contract.
    assert.deepEqual(
      completions.map((event) => event.providerCheckpointId),
      ["0", "1"],
    );

    const accepted = events.filter((event) => event.type === "turn/input/accepted");
    assert.deepEqual(
      accepted.map((event) => event.clientRequestId),
      ["creq_turnaaaa22", "creq_turnbbbb23"],
    );

    const started = events.filter((event) => event.type === "item/started");
    assert.ok(started.length >= 4, "each turn opened a tool row and a message");
    const ids = started.map((event) => event.item.id);
    assert.equal(new Set(ids).size, ids.length, `item ids repeat across turns: ${ids.join(", ")}`);

    const agentMessages = events.filter(
      (event) => event.type === "item/completed" && event.item?.type === "agentMessage",
    );
    assert.equal(agentMessages.length, 2);
    assert.deepEqual(
      agentMessages.map((event) => event.item.text),
      ["answer 0", "answer 1"],
    );
    assert.notEqual(agentMessages[0].item.id, agentMessages[1].item.id);

    // Usage: last = run usage + warmup usage; contextWindow.used = the first
    // model call's input_tokens.
    const usageEvents = events.filter((event) => event.type === "thread/tokenUsage/updated");
    assert.equal(usageEvents.length, 2);
    assert.deepEqual(usageEvents[0].tokenUsage.last, {
      inputTokens: 13466 + 9742,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 13471 + 9742,
    });
    const windowEvents = events.filter(
      (event) => event.type === "thread/contextWindowUsage/updated",
    );
    assert.ok(windowEvents.length >= 2);
    assert.equal(windowEvents[0].contextWindowUsage.usedTokens, 13466);
    assert.equal(windowEvents[0].contextWindowUsage.estimated, true);
  });

  it("a turn that dies before run.started still settles every request id", () => {
    const { messages, writer } = makeHarness();
    const scribe = writer.scribe({
      ordinal: 0,
      clientRequestIds: ["creq_deadkid234" as ClientTurnRequestId],
    });
    scribe.settle("failed", { error: { message: "nanocodex exited before run.started" } });

    const events = assemble(messages) as any[];
    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["turn/started", "turn/input/accepted", "turn/completed"]);
    assert.equal(events[2].status, "failed");
    assert.equal(events[2].error.message, "nanocodex exited before run.started");
  });
});
