import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AgentEvent } from "nanocodex/host";
import { createTurnProjector } from "./project.ts";
import { createThreadWriter } from "./timeline.ts";

test("typed AgentEvent objects project onto the canonical bb timeline", () => {
  const messages: unknown[] = [];
  const writer = createThreadWriter({
    threadId: "thread",
    providerThreadId: "provider",
    send: (message) => messages.push(message),
  });
  const scribe = writer.scribe({ ordinal: 7, clientRequestIds: ["request"] });
  const raw: unknown[] = [];
  const projector = createTurnProjector({ scribe, raw: (payload) => raw.push(payload) });

  assert.equal(projector.consume(event(1, "run.started", { model: "gpt-5.6-sol" })), false);
  scribe.acceptAll();
  projector.consume(event(2, "reasoning.summary.delta", { model_call_index: 1, text: "thinking" }));
  projector.consume(
    event(3, "model.call.completed", {
      call_index: 1,
      usage: { input_tokens: 13, output_tokens: 2, total_tokens: 15 },
    }),
  );
  projector.consume(
    event(4, "assistant.message", {
      model_call_index: 1,
      phase: "final_answer",
      text: "answer",
    }),
  );
  projector.consume(
    event(5, "tool.call", {
      call_id: "call-1",
      tool: "bash",
      arguments: { command: "pwd" },
    }),
  );
  projector.consume(
    event(6, "tool.result", {
      call_id: "call-1",
      tool: "bash",
      status: "completed",
      result: "/workspace",
    }),
  );
  assert.equal(projector.consume(event(7, "run.completed", { status: "completed" })), true);
  writer.flush();
  assert.equal(
    deltas(messages).some((delta) => delta.kind === "turn.boundary"),
    false,
  );

  scribe.settle("completed");
  const projected = deltas(messages);
  assert.deepEqual(raw, []);
  assert.ok(projected.some((delta) => delta.kind === "input.accepted"));
  assert.ok(
    projected.some(
      (delta) => delta.kind === "item.textDelta" && delta.channel === "reasoningSummary",
    ),
  );
  assert.ok(
    projected.some((delta) => delta.kind === "item.textDelta" && delta.channel === "agentMessage"),
  );
  assert.ok(projected.some((delta) => delta.kind === "item.open"));
  assert.equal(projected.at(-1)?.kind, "turn.boundary");
  assert.equal(projected.at(-1)?.providerCheckpointId, "7");
});

function event(seq: number, type: string, payload: Record<string, unknown>): AgentEvent {
  return { protocol_version: 1, request_id: "native-request", seq, type, payload };
}

function deltas(messages: readonly unknown[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const record = message as { method?: unknown; params?: { deltas?: unknown } };
    return record.method === "thread/delta" && Array.isArray(record.params?.deltas)
      ? (record.params.deltas as Record<string, unknown>[])
      : [];
  });
}
