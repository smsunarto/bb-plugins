import assert from "node:assert/strict";
import { test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge, handleLine } from "../src/bridge/entry.ts";

/**
 * A fake interactive Amp CLI: reads stream-json user messages line by line
 * and answers each with one NDJSON turn. It keeps running between turns
 * (stdin stays open), which is what lets the conformance suite drive several
 * turns and two independent threads through real spawned processes.
 *
 * Real interactive amp ends a turn with stop_reason "end_turn" on the
 * assistant message and sends no result line (U5 live smoke), so normal
 * turns here do the same. "NOOP" answers with a bare result line (a
 * zero-work turn, and the result-terminal path); "HOLD_OPEN" answers with
 * stop_reason "tool_use" — not a turn-end signal — leaving the turn open
 * until the suite interrupts it.
 */
const FAKE_CLI = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const sid = "T-fake-conformance";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
out({ type: "system", subtype: "init", session_id: sid, tools: ["Bash"], mcp_servers: [] });
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const blocks =
    message && message.message && Array.isArray(message.message.content)
      ? message.message.content
      : [];
  const text = blocks.map((b) => (b && b.type === "text" ? b.text : "")).join("");
  if (text.includes("NOOP")) {
    out({ type: "result", subtype: "success", is_error: false, session_id: sid });
    return;
  }
  out({
    type: "assistant",
    session_id: sid,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "echo: " + text }],
      stop_reason: text.includes("HOLD_OPEN") ? "tool_use" : "end_turn",
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  });
});
rl.on("close", () => process.exit(0));
`;

test("the amp bridge passes the SDK conformance suite", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-conformance-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const tempDir = join(root, "temp");
  for (const dir of [workspace, dataDir, tempDir]) mkdirSync(dir, { recursive: true });
  const fakeCli = join(root, "fake-amp.mjs");
  writeFileSync(fakeCli, FAKE_CLI, "utf8");
  chmodSync(fakeCli, 0o755);

  // The Amp SDK resolves its CLI from process.env, not from execute options.
  const previousCliPath = process.env.AMP_CLI_PATH;
  process.env.AMP_CLI_PATH = fakeCli;
  const output = captureBridgeJsonRpcOutput();
  try {
    experimental_providerBridge.start?.({ pluginId: "amp", dataDir, tempDir });
    const report = await runBridgeConformance({
      providerId: "acp-amp",
      transport: { send: handleLine, takeMessages: output.takeMessages },
      session: {
        cwd: workspace,
        promptInput: [{ type: "text", text: "say hello", mentions: [] }],
        zeroWorkPromptInput: [{ type: "text", text: "NOOP", mentions: [] }],
        interruptiblePromptInput: [{ type: "text", text: "HOLD_OPEN", mentions: [] }],
      },
      timeoutMs: 15_000,
    });
    for (const result of report.results) {
      assert.equal(result.status, "pass", `${result.id}: ${result.detail ?? ""}`);
    }
    assert.equal(report.passed, true, formatConformanceReport(report));
  } finally {
    output.restore();
    if (previousCliPath === undefined) delete process.env.AMP_CLI_PATH;
    else process.env.AMP_CLI_PATH = previousCliPath;
    rmSync(root, { recursive: true, force: true });
  }
});
