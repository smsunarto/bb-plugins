/**
 * `test/fake-nanocodex.ts` — a scripted nanocodex, as a string.
 *
 * The conformance suite and the stream tests both need a child that behaves
 * like `nanocodex run` without an account, a network, or a model. The fake is
 * a node script written to a temp dir and selected through
 * `BB_NANOCODEX_COMMAND` / `BB_NANOCODEX_ARGS`, which is the same env-override
 * seam provider-codex uses for `fake-codex-app-server.mjs`. The bridge under
 * test is the REAL bridge, spawning a REAL child, over REAL argv — the seam
 * substitutes only the binary.
 *
 * It branches on the positional prompt, which is the only input a real
 * `nanocodex run` takes. Because this bridge stitches history INTO that prompt,
 * the fake sees the stitched text and can assert on it: `test/prompt.test.ts`
 * drives two turns and checks that turn 2's argv contains turn 1's answer.
 * That is the continuity design's end-to-end test, and it needs no model.
 *
 * Implementation seed: `fake-nanocodex-seed.mjs` beside this file is a WORKING
 * fake (candidate-2's, exercised against the real conformance suite). Extend
 * it with the modes below rather than writing envelope plumbing from scratch;
 * its envelope framing, seq numbering, and SIGINT handling are already right.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Modes, keyed by substring of the prompt:
 *
 *   NOOP        `run.started` then `run.completed` with no items — the
 *               zero-work turn. Gates `turn/settles-without-activity`.
 *   HOLD_OPEN   `run.started` then silence. Exits only on SIGINT, and then
 *               emits `run.completed {status:"cancelled"}` first, which is what
 *               real nanocodex does. Gates `stop/interrupt-settles-before-result`
 *               and `session/threads-independent`.
 *   HOLD_HARD   `run.started` then silence, and IGNORES SIGINT. Forces the
 *               SIGKILL escalation and the synthesized interrupted boundary —
 *               the path that is a rare fallback for codex and a routine one
 *               here.
 *   DIE         exits 1 with `Error: boom` on stderr and no terminal event.
 *               Gates the `no-terminal` outcome.
 *   RETRY       exits 75, nanocodex's RETRYABLE_EXIT_CODE.
 *   TOOLS       replays the code-mode sequence from the tool-run fixture:
 *               `tool.call {tool:"exec", arguments:<string>}`, two
 *               `<parent>/code-N` children, then the parent result as content
 *               blocks. Gates the string-arguments schema and `parentRef`.
 *   anything    `assistant.delta` x3, `assistant.message`, `model.call.completed`
 *               with a call-1 usage block, `run.completed`.
 *
 * Every mode emits `api.event` lines between the real ones, so the suppression
 * path is exercised on every run rather than only in a dedicated test.
 */
export const FAKE_NANOCODEX_SCRIPT = `#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const runIndex = argv.indexOf("run");
const prompt = runIndex === -1 ? (argv[0] ?? "") : (argv[runIndex + 1] ?? "");
const requestMatch = /<bb-request>\\n([\\s\\S]*?)\\n<\\/bb-request>/.exec(prompt);
const request = requestMatch === null ? prompt : requestMatch[1];

const requestId = randomUUID();
let seq = 0;
let terminalSent = false;
let keepAlive = null;

function emit(type, payload) {
  seq += 1;
  process.stdout.write(
    JSON.stringify({ protocol_version: 1, request_id: requestId, seq, type, payload }) + "\\n",
  );
}

function apiNoise() {
  emit("api.event", {
    direction: "inbound",
    transport: "responses_websocket_v2",
    phase: "turn",
    event: { type: "response.output_text.delta", noise: "x".repeat(64) },
  });
}

const USAGE = {
  input_tokens: 5,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 7,
  reasoning_output_tokens: 0,
  total_tokens: 12,
};
const WARMUP_USAGE = {
  input_tokens: 2,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 2,
};

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
    usage: USAGE,
    warmup_usage: WARMUP_USAGE,
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
apiNoise();

if (request.includes("HOLD_HARD")) {
  process.on("SIGINT", () => {});
  keepAlive = setInterval(() => {}, 1_000);
} else {
  process.once("SIGINT", () => {
    terminal("cancelled");
    process.exitCode = 1;
    if (keepAlive !== null) clearInterval(keepAlive);
  });
}

if (request.includes("HOLD_OPEN")) {
  keepAlive = setInterval(() => {}, 1_000);
} else if (request.includes("HOLD_HARD")) {
  // SIGINT ignored above; the interval keeps the loop alive until SIGKILL.
} else if (request.includes("NOOP")) {
  terminal("completed");
} else if (request.includes("DIE")) {
  process.stderr.write("Error: boom\\n");
  process.exitCode = 1;
} else if (request.includes("RETRY")) {
  process.stderr.write("Error: transient\\n");
  process.exitCode = 75;
} else if (request.includes("TOOLS")) {
  const parent = "call_" + requestId.slice(0, 8);
  emit("tool.call", {
    call_id: parent,
    tool: "exec",
    arguments: 'const edited = await tools.apply_patch(patch);\\nawait tools.exec_command({cmd:"od -An -t c hello.txt"});',
    model_call_index: 1,
  });
  apiNoise();
  emit("tool.call", {
    call_id: parent + "/code-1",
    tool: "apply_patch",
    arguments: "*** Begin Patch\\n*** Add File: hello.txt\\n+hi\\n*** End Patch",
    model_call_index: 1,
  });
  emit("tool.result", {
    call_id: parent + "/code-1",
    tool: "apply_patch",
    status: "completed",
    duration_ns: 260958,
    result: "Success. Updated the following files:\\nA hello.txt\\n",
    structured_result: {},
  });
  apiNoise();
  emit("tool.call", {
    call_id: parent + "/code-2",
    tool: "exec_command",
    arguments: { cmd: "od -An -t c hello.txt", workdir: process.cwd() },
    model_call_index: 1,
  });
  emit("tool.result", {
    call_id: parent + "/code-2",
    tool: "exec_command",
    status: "completed",
    duration_ns: 14358625,
    result: "   h   i  \\\\n\\n",
  });
  emit("tool.result", {
    call_id: parent,
    tool: "exec",
    status: "completed",
    duration_ns: 21326375,
    result: [
      { type: "input_text", text: "Script completed\\nWall time 0.0 seconds\\nOutput:\\n" },
      { type: "input_text", text: "hi" },
    ],
  });
  apiNoise();
  emit("assistant.message", {
    model_call_index: 1,
    item_id: "msg_" + requestId.slice(0, 8),
    phase: "final_answer",
    text: "wrote hello.txt",
  });
  emit("model.call.completed", {
    call_index: 1,
    model: "gpt-5.6-sol",
    status: "completed",
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 20,
      total_tokens: 120,
    },
  });
  terminal("completed");
} else {
  const itemId = "msg_" + requestId.slice(0, 8);
  for (const piece of ["fake ", "answer ", "text"]) {
    emit("assistant.delta", {
      model_call_index: 1,
      item_id: itemId,
      phase: "final_answer",
      text: piece,
    });
    apiNoise();
  }
  emit("assistant.message", {
    model_call_index: 1,
    item_id: itemId,
    phase: "final_answer",
    text: "fake answer text",
  });
  emit("model.call.completed", {
    call_index: 1,
    model: "gpt-5.6-sol",
    status: "completed",
    usage: {
      input_tokens: 42,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens: 9,
      total_tokens: 51,
    },
  });
  terminal("completed");
}
`;

/** Write the fake into `dir` and return the argv pair for the override env vars. */
export function installFakeNanocodex(dir: string): { command: string; args: string[] } {
  const path = join(dir, "fake-nanocodex.mjs");
  writeFileSync(path, FAKE_NANOCODEX_SCRIPT, "utf8");
  chmodSync(path, 0o755);
  return { command: process.execPath, args: [path] };
}
