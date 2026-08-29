#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const prompt = process.argv.at(-1) ?? "";
const requestId = randomUUID();
let seq = 0;
let terminalSent = false;

function emit(type, payload) {
  seq += 1;
  process.stdout.write(
    `${JSON.stringify({ protocol_version: 1, request_id: requestId, seq, type, payload })}\n`,
  );
}

function terminal(status) {
  if (terminalSent) return;
  terminalSent = true;
  emit("run.completed", {
    status,
    model: "gpt-5.6-sol",
    reasoning_mode: "standard",
    effort: "low",
    transport: "fake",
    orchestration: "local_code_mode",
    usage: {
      input_tokens: 5,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 7,
      reasoning_output_tokens: 0,
      total_tokens: 12,
    },
    warmup_usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    },
    estimated_cost: {
      usd: "0",
      input_usd: "0",
      cached_input_usd: "0",
      cache_write_input_usd: "0",
      output_usd: "0",
      service_tier: "standard",
    },
    cost_usd: 0,
  });
}

emit("run.started", {
  mode: "openai_model",
  model: "gpt-5.6-sol",
  reasoning_mode: "standard",
  effort: "low",
  transport: "fake",
  orchestration: "local_code_mode",
  workspace: process.cwd(),
  instruction_bytes: 0,
});

process.once("SIGINT", () => {
  terminal("cancelled");
  setImmediate(() => process.exit(1));
});

if (prompt.includes("__BB_INTERRUPT__")) {
  // Keep the event loop alive until the bridge exercises SIGINT.
  setInterval(() => {}, 1_000);
} else if (prompt.includes("__BB_ZERO_WORK__")) {
  terminal("completed");
} else {
  const itemId = `msg_${requestId}`;
  emit("assistant.delta", {
    model_call_index: 1,
    item_id: itemId,
    phase: "final_answer",
    text: "fake answer",
  });
  emit("assistant.message", {
    model_call_index: 1,
    item_id: itemId,
    phase: "final_answer",
    text: "fake answer",
  });
  terminal("completed");
}
