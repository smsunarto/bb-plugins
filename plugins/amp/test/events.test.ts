import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  classifyAmpError,
  parseAmpBatch,
  parseAmpImageBlock,
  parseUnsupportedFlag,
  type AmpEvent,
} from "../src/bridge/events.ts";

const THREAD = "T-events-test";

function kinds(events: readonly AmpEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe("parseAmpBatch boundary", () => {
  it("wraps a non-object line as a raw unknown event", () => {
    const batch = parseAmpBatch("not json traffic");
    assert.equal(batch.ampThreadId, null);
    assert.equal(batch.terminal, false);
    assert.deepEqual(batch.events, [
      { kind: "raw", coverage: "unknown", payload: "not json traffic" },
    ]);
  });

  it("wraps an unrecognized message type as raw unknown and keeps the payload", () => {
    const batch = parseAmpBatch({ type: "telemetry", session_id: THREAD, n: 1 });
    assert.equal(batch.ampThreadId, THREAD);
    assert.equal(batch.terminal, false);
    assert.deepEqual(batch.events, [
      {
        kind: "raw",
        coverage: "unknown",
        payload: { type: "telemetry", session_id: THREAD, n: 1 },
      },
    ]);
  });

  it("treats an empty session_id as no thread id", () => {
    const batch = parseAmpBatch({ type: "assistant", session_id: "", message: { content: [] } });
    assert.equal(batch.ampThreadId, null);
  });
});

describe("system messages", () => {
  it("parses init with the tool roster and raw MCP statuses", () => {
    const batch = parseAmpBatch({
      type: "system",
      subtype: "init",
      session_id: THREAD,
      cwd: "/",
      tools: ["Bash", 7, "Read"],
      mcp_servers: [
        { name: "github", status: "awaiting-approval" },
        { name: "flaky", status: 42 },
        "junk",
        { name: "database", status: "connected" },
      ],
    });
    assert.equal(batch.terminal, false);
    assert.equal(batch.ampThreadId, THREAD);
    assert.deepEqual(batch.events, [
      {
        kind: "init",
        tools: ["Bash", "Read"],
        mcpServers: [
          { name: "github", status: "awaiting-approval" },
          { name: "database", status: "connected" },
        ],
      },
    ]);
  });

  it("turns a non-init system error into a terminal resultError", () => {
    const batch = parseAmpBatch({
      type: "system",
      subtype: "error_during_execution",
      session_id: THREAD,
      error: "cli exploded",
    });
    assert.equal(batch.terminal, true);
    assert.deepEqual(batch.events, [
      {
        kind: "resultError",
        subtype: "error_during_execution",
        message: "cli exploded",
        denials: [],
      },
    ]);
  });

  it("keeps a non-init system line without an error as raw noise", () => {
    const batch = parseAmpBatch({ type: "system", subtype: "status", session_id: THREAD });
    assert.equal(batch.terminal, false);
    assert.deepEqual(kinds(batch.events), ["raw"]);
    assert.equal(batch.events[0].kind === "raw" && batch.events[0].coverage, "noise");
  });
});

describe("assistant messages", () => {
  it("emits text, thinking, and tool starts in block order, then the stop", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      message: {
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "hello" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { cmd: "ls" } },
        ],
        stop_reason: "end_turn",
      },
    });
    assert.equal(batch.terminal, false);
    assert.deepEqual(batch.events, [
      { kind: "thinking", text: "pondering", parent: null },
      { kind: "text", text: "hello", parent: null },
      { kind: "toolStart", callId: "tool-1", tool: "Bash", input: { cmd: "ls" }, parent: null },
      { kind: "assistantStop", reason: "end_turn" },
    ]);
  });

  it("skips empty text and thinking blocks entirely", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      message: {
        content: [
          { type: "text", text: "" },
          { type: "thinking", thinking: "" },
        ],
      },
    });
    assert.deepEqual(batch.events, []);
  });

  it("accepts plain string content", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      message: { content: "plain reply" },
    });
    assert.deepEqual(batch.events, [{ kind: "text", text: "plain reply", parent: null }]);
  });

  it("propagates parent_tool_use_id onto content events", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      parent_tool_use_id: "oracle-1",
      message: { content: [{ type: "text", text: "sub agent says" }] },
    });
    assert.deepEqual(batch.events, [{ kind: "text", text: "sub agent says", parent: "oracle-1" }]);
  });

  it("normalizes a base64 image block and lowercases the mime type", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      message: {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "IMAGE/WEBP", data: "aGVs bG8=" },
          },
        ],
      },
    });
    assert.deepEqual(batch.events, [
      { kind: "image", image: { mimeType: "image/webp", base64: "aGVsbG8=" }, parent: null },
    ]);
  });

  it("keeps a url image as a link and drops invalid base64", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      message: {
        content: [
          { type: "image", source: { type: "url", url: " https://example.com/a.png " } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "!!!" } },
        ],
      },
    });
    assert.deepEqual(batch.events, [
      { kind: "image", image: { url: "https://example.com/a.png" }, parent: null },
    ]);
  });

  it("emits a usage event from message usage with zero defaults", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      message: {
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
      },
    });
    assert.deepEqual(batch.events, [
      { kind: "text", text: "hi", parent: null },
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 3,
        },
      },
    ]);
  });

  it("does not emit assistantStop for tool_use stops", () => {
    const batch = parseAmpBatch({
      type: "assistant",
      session_id: THREAD,
      message: { content: [], stop_reason: "tool_use" },
    });
    assert.deepEqual(batch.events, []);
  });
});

describe("user messages", () => {
  it("collapses an all-text top-level user message into a userEcho", () => {
    const batch = parseAmpBatch({
      type: "user",
      session_id: THREAD,
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    assert.equal(batch.terminal, false);
    assert.deepEqual(batch.events, [{ kind: "userEcho", text: "Hello world" }]);
  });

  it("does not echo when the user message carries a parent id", () => {
    const batch = parseAmpBatch({
      type: "user",
      session_id: THREAD,
      parent_tool_use_id: "oracle-1",
      message: { content: [{ type: "text", text: "sub prompt" }] },
    });
    assert.deepEqual(batch.events, []);
  });

  it("parses tool results with structured content and the error flag", () => {
    const content = [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ];
    const batch = parseAmpBatch({
      type: "user",
      session_id: THREAD,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content, is_error: true },
          { type: "tool_result", tool_use_id: "tool-2", content: "plain output" },
        ],
      },
    });
    assert.deepEqual(batch.events, [
      {
        kind: "toolEnd",
        callId: "tool-1",
        output: { text: "line one\nline two", structured: content },
        failed: true,
        parent: null,
      },
      {
        kind: "toolEnd",
        callId: "tool-2",
        output: { text: "plain output", structured: null },
        failed: false,
        parent: null,
      },
    ]);
  });

  it("treats a missing tool_result content as empty output", () => {
    const batch = parseAmpBatch({
      type: "user",
      session_id: THREAD,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] },
    });
    assert.deepEqual(batch.events, [
      {
        kind: "toolEnd",
        callId: "tool-1",
        output: { text: "", structured: null },
        failed: false,
        parent: null,
      },
    ]);
  });
});

describe("result messages", () => {
  it("is terminal and reports denials on success", () => {
    const batch = parseAmpBatch({
      type: "result",
      subtype: "success",
      session_id: THREAD,
      is_error: false,
      result: "done",
      permission_denials: ["Bash", 3, "Write"],
    });
    assert.equal(batch.terminal, true);
    assert.deepEqual(batch.events, [{ kind: "resultOk", denials: ["Bash", "Write"] }]);
  });

  it("emits usage before the result event", () => {
    const batch = parseAmpBatch({
      type: "result",
      subtype: "success",
      session_id: THREAD,
      is_error: false,
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    assert.deepEqual(kinds(batch.events), ["usage", "resultOk"]);
  });

  it("classifies error results and keeps their denials", () => {
    const batch = parseAmpBatch({
      type: "result",
      subtype: "error_max_turns",
      session_id: THREAD,
      is_error: true,
      error: "ran out of turns",
      permission_denials: ["Bash"],
    });
    assert.equal(batch.terminal, true);
    assert.deepEqual(batch.events, [
      {
        kind: "resultError",
        subtype: "error_max_turns",
        message: "ran out of turns",
        denials: ["Bash"],
      },
    ]);
  });

  it("falls back to a generic message when an error result has no error text", () => {
    const batch = parseAmpBatch({ type: "result", subtype: "failed", is_error: true });
    assert.deepEqual(batch.events, [
      { kind: "resultError", subtype: "unknown", message: "unknown error", denials: [] },
    ]);
  });
});

describe("classifyAmpError", () => {
  it("keeps error_max_turns even when the text looks auth-shaped", () => {
    assert.equal(classifyAmpError("error_max_turns", "run 'amp login'"), "error_max_turns");
    assert.equal(
      classifyAmpError("error_max_turns", "OpenAI WebSocket closed: 1006"),
      "error_max_turns",
    );
  });

  it("splits error_during_execution on auth-shaped text", () => {
    assert.equal(
      classifyAmpError("error_during_execution", "Invalid or missing API key"),
      "auth_required",
    );
    assert.equal(
      classifyAmpError("error_during_execution", "cli exploded"),
      "error_during_execution",
    );
  });

  it("detects auth, unsupported flags, and unknown for other subtypes", () => {
    assert.equal(classifyAmpError("error", "Unauthorized"), "auth_required");
    assert.equal(
      classifyAmpError(undefined, "error: unknown option '--effort'"),
      "unsupported_option",
    );
    assert.equal(classifyAmpError(undefined, "boom"), "unknown");
  });
});

describe("parseUnsupportedFlag", () => {
  it("extracts the flag from straight and curly quoting", () => {
    assert.equal(parseUnsupportedFlag("error: unknown option '--mcp-config'"), "mcp-config");
    assert.equal(parseUnsupportedFlag("error: unknown option ‘--settings-file’"), "settings-file");
  });

  it("lowercases the flag and returns null when absent", () => {
    assert.equal(parseUnsupportedFlag("Unknown option '--EFFORT'"), "effort");
    assert.equal(parseUnsupportedFlag("something else went wrong"), null);
  });
});

describe("parseAmpImageBlock", () => {
  it("returns null for payloads no renderer could display", () => {
    assert.equal(parseAmpImageBlock({ type: "image" }), null);
    assert.equal(parseAmpImageBlock({ type: "image", source: { type: "url", url: "   " } }), null);
    assert.equal(
      parseAmpImageBlock({
        type: "image",
        source: { type: "base64", media_type: "text/plain", data: "aGVsbG8=" },
      }),
      null,
    );
  });
});
