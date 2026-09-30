import { test } from "node:test";
import assert from "node:assert/strict";
import { experimental_assembleCapturedThreadEvents as assemble } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createTurnSettler } from "./turn-settle.ts";

type Timer = { at: number; fire: () => void };

/** A settler on a manual clock. `advance` fires due timers in order. */
function harness(options: { maxHoldMs?: number; graceMs?: number } = {}) {
  const out: string[] = [];
  let now = 0;
  const timers = new Set<Timer>();
  const settler = createTurnSettler({
    write: (line) => out.push(line),
    schedule: (ms, fire) => {
      const timer = { at: now + ms, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    ...options,
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.delete(due);
      now = due.at;
      due.fire();
    }
    now = until;
  };
  return { settler, out, advance };
}

const line = (message: unknown) => JSON.stringify(message);
const delta = (threadId: string, deltas: unknown[]) =>
  line({ jsonrpc: "2.0", method: "thread/delta", params: { threadId, deltas } });
// Shaped as the SDK bridge emits an agent_message_chunk, fallback included.
const text = (threadId: string, value: string) =>
  delta(threadId, [
    {
      kind: "item.textDelta",
      key: { channel: "assistant" },
      channel: "agentMessage",
      text: value,
      noTurnFallback: {
        raw: { jsonrpc: "2.0", method: "session/update", params: {} },
        rawType: "agent_message_chunk",
      },
    },
  ]);
const end = (threadId: string, status = "completed") =>
  delta(threadId, [
    { kind: "item.textClose", key: { channel: "assistant" }, channel: "agentMessage" },
    { kind: "turn.boundary", status, claimIfIdle: true },
  ]);
const toolCall = (threadId: string) =>
  delta(threadId, [
    { kind: "item.toolCall", key: { toolCallId: "ctx" }, title: "context growth updated" },
  ]);
const start = (threadId: string, args: string[]) =>
  line({
    jsonrpc: "2.0",
    id: 1,
    method: "thread/start",
    params: {
      threadId,
      options: { providerOptions: { acpLaunchSpec: { command: "devin", args } } },
    },
  });
const turnStart = (threadId: string) =>
  line({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId, input: [] } });

const CLOUD = ["acp", "--cloud"];
const LOCAL = ["acp"];

test("a Cloud turn's end waits for the late final message, which lands first", () => {
  const { settler, out, advance } = harness();
  settler.beforeInbound(start("thr_c", CLOUD));
  settler.write(text("thr_c", "I'll run it."));
  settler.write(end("thr_c"));
  assert.deepEqual(out, [text("thr_c", "I'll run it.")]);

  advance(250);
  settler.write(text("thr_c", "origin main"));
  assert.deepEqual(out, [text("thr_c", "I'll run it."), text("thr_c", "origin main")]);

  advance(99);
  assert.equal(out.length, 2);
  advance(1);
  assert.deepEqual(out, [
    text("thr_c", "I'll run it."),
    text("thr_c", "origin main"),
    end("thr_c"),
  ]);
});

test("with no late message the end goes out at the hold limit, followed by what queued behind it", () => {
  const { settler, out, advance } = harness();
  settler.beforeInbound(start("thr_c", CLOUD));
  settler.write(end("thr_c"));
  settler.write(toolCall("thr_c"));
  assert.deepEqual(out, []);
  advance(1499);
  assert.deepEqual(out, []);
  advance(1);
  assert.deepEqual(out, [end("thr_c"), toolCall("thr_c")]);
});

test("local threads, other threads, and non-delta lines pass straight through", () => {
  const { settler, out } = harness();
  settler.beforeInbound(start("thr_l", LOCAL));
  settler.beforeInbound(start("thr_c", CLOUD));
  const result = line({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  settler.write(end("thr_l"));
  settler.write(end("thr_c"));
  settler.write(result);
  settler.write("not json\n");
  settler.write(text("thr_l", "hello"));
  settler.write(end("thr_c", "cancelled"));
  assert.deepEqual(out, [end("thr_l"), result, "not json\n", text("thr_l", "hello")]);
});

test("a request from bb naming the held thread releases the end before the bridge sees it", () => {
  const { settler, out } = harness();
  settler.beforeInbound(start("thr_c", CLOUD));
  settler.write(end("thr_c"));
  settler.beforeInbound(turnStart("thr_c"));
  assert.deepEqual(out, [end("thr_c")]);
  settler.beforeInbound(turnStart("thr_other"));
});

test("flush releases every held thread", () => {
  const { settler, out } = harness();
  settler.beforeInbound(start("thr_a", CLOUD));
  settler.beforeInbound(start("thr_b", CLOUD));
  settler.write(end("thr_a"));
  settler.write(end("thr_b"));
  settler.flush();
  assert.deepEqual(out, [end("thr_a"), end("thr_b")]);
  settler.flush();
  assert.equal(out.length, 2);
});

test("bb's assembler files the late message inside the turn once settled", () => {
  const { settler, out, advance } = harness();
  settler.beforeInbound(start("thr_c", CLOUD));
  const raced = [text("thr_c", "I'll run it."), end("thr_c"), text("thr_c", "origin main")];
  const events = (lines: string[]) =>
    assemble(
      lines.map((l) => JSON.parse(l) as { method: string; params: unknown }),
      "devin",
    ).map((event) =>
      event.type === "item/completed"
        ? `${event.type} ${event.item.type} ${(event.item as { text?: string }).text}`
        : event.type,
    );

  assert.deepEqual(events([delta("thr_c", [{ kind: "turn.open" }]), ...raced]), [
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
    "item/completed agentMessage I'll run it.",
    "turn/completed",
    "provider/unhandled",
  ]);

  settler.write(delta("thr_c", [{ kind: "turn.open" }]));
  for (const l of raced) settler.write(l);
  advance(100);
  assert.deepEqual(events(out), [
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
    "item/agentMessage/delta",
    "item/completed agentMessage I'll run it.origin main",
    "turn/completed",
  ]);
});
