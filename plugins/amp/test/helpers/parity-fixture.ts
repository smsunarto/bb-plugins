// Shared between the parity recorder (record-parity.ts) and the parity test
// (bridge-parity.test.ts): both must materialize the exact same fake CLI at
// the exact same absolute paths, because the recorded wire embeds
// `providerOptions.ampCliPath` and the session cwd, and a replay re-executes
// them for real.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Fixed POSIX root the recordings reference. Recreated by every run. */
export const PARITY_ROOT = "/tmp/amp-parity";

/** The recorded subset of the SDK's conformance cell matrix. The other four
 * cells do not exist for this provider: the bridge asks no approvals
 * (approval-allow, approval-deny), declares supportsNativeUserQuestion false
 * (user-question), and fork "none" (fork). A recorded-cell tree only lists
 * directories that exist, so the subset is valid. */
export const PARITY_CELLS = ["turn-tools", "steer", "stop-interrupt", "resume"] as const;

/**
 * A fake deterministic interactive Amp CLI (same protocol as the conformance
 * fake, plus a TOOL flow): reads stream-json user messages line by line and
 * answers each from its text triggers. No timestamps, no randomness — replay
 * must reproduce the recorded provider traffic exactly.
 *
 * - "TOOL": one tool_use assistant message, its tool_result, then a final
 *   end_turn message — the turn-tools cell.
 * - "HOLD_OPEN": stop_reason "tool_use" with no follow-up, leaving the turn
 *   open for a steer or an interrupt.
 * - "NOOP": a bare result line (the result-terminal path).
 * - anything else: one echoed end_turn message.
 */
export const FAKE_CLI = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const sid = "T-fake-parity";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const usage = { input_tokens: 5, output_tokens: 7 };
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
  if (text.includes("TOOL")) {
    out({
      type: "assistant",
      session_id: sid,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running the tool." },
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { cmd: "echo hi" } },
        ],
        stop_reason: "tool_use",
        usage,
      },
    });
    out({
      type: "user",
      session_id: sid,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "hi", is_error: false }],
      },
    });
    out({
      type: "assistant",
      session_id: sid,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The tool ran." }],
        stop_reason: "end_turn",
        usage,
      },
    });
    return;
  }
  out({
    type: "assistant",
    session_id: sid,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "echo: " + text }],
      stop_reason: text.includes("HOLD_OPEN") ? "tool_use" : "end_turn",
      usage,
    },
  });
});
rl.on("close", () => process.exit(0));
`;

/** Creates the fixed directories the recordings reference. */
export function prepareParityRoot(): void {
  mkdirSync(join(PARITY_ROOT, "workspace"), { recursive: true });
}
