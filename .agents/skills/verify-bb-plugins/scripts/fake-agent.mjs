#!/usr/bin/env node
// A local ACP agent for the test instance: no model, no network, no cost.
// It answers every prompt with the text of FAKE_AGENT_REPLY (a file path),
// or "verify fake agent: ok" when that is unset or missing. A {{ECHO}} in
// the reply file is replaced by everything bb sent in the prompt, agent-only
// context included. FAKE_AGENT_LOG, when set, receives every message as JSONL.
// Register it as a provider-acp custom agent; SKILL.md "Free agent turns" has
// the recipe.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_AGENT_LOG;
const REPLY = process.env.FAKE_AGENT_REPLY;
const log = (dir, message) => {
  if (!LOG) return;
  try {
    appendFileSync(LOG, `${JSON.stringify({ t: new Date().toISOString(), dir, message })}\n`);
  } catch {}
};
const send = (message) => {
  log("out", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

let sessions = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log("in", message);
  // Notifications (no id) and responses to our own requests (no method) need no answer.
  if (message.id === undefined || message.method === undefined) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
      });
    case "authenticate":
    case "session/set_mode":
    case "session/set_model":
    case "session/set_config_option":
      return ok({});
    case "session/new":
      return ok({ sessionId: `fake-${process.pid}-${++sessions}` });
    case "session/prompt": {
      const prompt = (message.params?.prompt ?? [])
        .map((block) => block.text ?? block.resource?.text ?? JSON.stringify(block))
        .join("\n---\n");
      let text = "verify fake agent: ok";
      if (REPLY && existsSync(REPLY)) text = readFileSync(REPLY, "utf8");
      text = text.replace("{{ECHO}}", prompt);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
      return ok({ stopReason: "end_turn" });
    }
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
});
