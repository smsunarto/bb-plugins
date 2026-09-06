import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureRecords } from "../../../test/fixtures";
import { bodySchema, eventFieldsSchema, type ParsedEvent, type TraceAdapter } from "../model";
import { builtinAdapters, createAdapterRegistry } from "./index";

const registry = createAdapterRegistry(builtinAdapters);
const claude = registry.lookup("claude-code")!;
const codex = registry.lookup("codex")!;

function parse(adapter: TraceAdapter, record: unknown): ParsedEvent[] {
  return adapter.parse(record, { path: "/fixtures/session.jsonl", line: 1 }).events;
}

function fixtureEvents(adapter: TraceAdapter): ParsedEvent[] {
  return fixtureRecords(adapter.id as "claude-code" | "codex").flatMap(
    (record, index) =>
      adapter.parse(record, { path: "/fixtures/session.jsonl", line: index + 1 }).events,
  );
}

function resolvePointer(value: unknown, pointer: string): unknown {
  assert.ok(pointer === "" || pointer.startsWith("/"), pointer);
  return pointer === ""
    ? value
    : pointer
        .slice(1)
        .split("/")
        .reduce<unknown>((current, key) => {
          assert.ok(
            current !== null && typeof current === "object",
            `Cannot descend through ${pointer}`,
          );
          const decoded = key.replaceAll("~1", "/").replaceAll("~0", "~");
          assert.ok(decoded in current, `Missing source field ${pointer}`);
          return (current as Record<string, unknown>)[decoded];
        }, value);
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}

function claudeMessage(content: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    type: "assistant",
    uuid: "message-1",
    parentUuid: "message-0",
    sessionId: "session-1",
    timestamp: "2026-09-06T00:00:00Z",
    message: { role: "assistant", content },
    ...extra,
  };
}

function codexCall(name: string, args: unknown, custom = false): unknown {
  return {
    type: "response_item",
    payload: {
      type: custom ? "custom_tool_call" : "function_call",
      id: "event-1",
      name,
      call_id: "call-1",
      [custom ? "input" : "arguments"]: custom ? args : JSON.stringify(args),
    },
  };
}

describe("adapter registry", () => {
  it("registers only the two builtins and supports independent extension", () => {
    assert.deepEqual(
      registry.list().map((adapter) => adapter.id),
      ["claude-code", "codex"],
    );
    assert.equal(registry.lookup("pi"), undefined);
    const extra = { ...codex, id: "test-provider" };
    const extended = createAdapterRegistry([...builtinAdapters, extra]);
    assert.equal(extended.lookup(extra.id), extra);
    assert.throws(() => createAdapterRegistry([codex, codex]), /Duplicate trace adapter ID/);
    assert.throws(() => createAdapterRegistry([{ ...codex, id: " " }]), /must not be empty/);
  });

  it("resolves provider roots without reading environment or filesystem", () => {
    assert.deepEqual(claude.roots("/home/test", {}), ["/home/test/.claude/projects"]);
    assert.deepEqual(codex.roots("/home/test", {}), [
      "/home/test/.codex/sessions",
      "/home/test/.codex/archived_sessions",
    ]);
    assert.deepEqual(claude.roots("/home/test", { CLAUDE_CONFIG_DIR: "~/custom/" }), [
      "/home/test/custom/projects",
    ]);
    assert.deepEqual(codex.roots("/home/test", { CODEX_HOME: "/custom/codex/" }), [
      "/custom/codex/sessions",
      "/custom/codex/archived_sessions",
    ]);
    assert.deepEqual(codex.roots("/home/test", { CODEX_HOME: " " }), codex.roots("/home/test", {}));
    assert.equal(claude.accepts("/project/subagents/agent-123.jsonl"), true);
    assert.equal(codex.accepts("rollout.jsonl"), true);
    assert.equal(codex.accepts("history.json"), false);
    assert.equal(claude.accepts("trace.jsonl.backup"), false);
  });
});

for (const adapter of builtinAdapters) {
  describe(`${adapter.label} fixtures`, () => {
    it("produces valid bounded summaries with source-resolving event and evidence pointers", () => {
      fixtureRecords(adapter.id as "claude-code" | "codex").forEach((record, index) => {
        freeze(record);
        const first = adapter.parse(record, { path: "/fixture.jsonl", line: index + 1 });
        assert.deepEqual(first, adapter.parse(record, { path: "/fixture.jsonl", line: index + 1 }));
        assert.ok(first.events.length > 0);
        first.events.forEach((event) => {
          eventFieldsSchema.parse(event);
          bodySchema.parse(event.body);
          resolvePointer(record, event.pointer);
          event.evidence.forEach((fact) => resolvePointer(record, fact.pointer));
          assert.ok(event.title.length <= 160);
          assert.ok(event.preview.length <= 2048);
          assert.ok(event.evidence.length <= 64);
          assert.ok(event.evidence.every((fact) => fact.label.length <= 256));
        });
      });
    });

    it("keeps skill and plugin availability separate from invocation", () => {
      const facts = fixtureEvents(adapter).flatMap((event) => event.evidence);
      assert.ok(
        facts.some(
          (fact) =>
            fact.topic === "skills" &&
            fact.label === "unused-design" &&
            fact.action === "available",
        ),
      );
      assert.ok(
        facts.some(
          (fact) =>
            fact.topic === "plugins" &&
            fact.label === "unused-calendar" &&
            fact.action === "available",
        ),
      );
      assert.ok(
        !facts.some(
          (fact) => /unused-design|unused-calendar/.test(fact.label) && fact.action !== "available",
        ),
      );
      assert.ok(facts.some((fact) => fact.topic === "mcp" && fact.action === "invoked"));
      assert.ok(
        facts.some((fact) => fact.topic === "search" && fact.label === "Native web search"),
      );
      assert.ok(
        facts.some((fact) => fact.topic === "search" && fact.label === "Parallel web search"),
      );
      assert.ok(
        facts.some((fact) => fact.topic === "search" && fact.label === "Parallel CLI search"),
      );
      assert.ok(facts.some((fact) => fact.topic === "subagents" && fact.action === "invoked"));
    });

    it("keeps denied execution and bypass requests distinct", () => {
      const events = fixtureEvents(adapter);
      const facts = events.flatMap((event) => event.evidence);
      assert.ok(facts.some((fact) => fact.topic === "sandbox" && fact.action === "blocked"));
      assert.ok(
        facts.some((fact) => fact.topic === "sandbox" && fact.action === "bypass_requested"),
      );
      assert.ok(!facts.some((fact) => fact.action === "bypass_enabled"));
      assert.ok(
        events
          .filter((event) => event.evidence.some((fact) => fact.action === "blocked"))
          .every((event) => event.kind === "tool_result" && event.tool?.status === "error"),
      );
    });

    it("retains unknown and non-object records as diagnostic data", () => {
      for (const value of [
        null,
        12,
        "text",
        [],
        { type: "future-event", nested: { preserved: true } },
      ]) {
        const [event] = parse(adapter, value);
        assert.equal(event?.kind, "diagnostic");
        assert.deepEqual(event?.body, { type: "data", value });
        assert.deepEqual(event?.evidence, []);
      }
    });
  });
}

describe("Claude Code normalization", () => {
  it("splits mixed content, preserves identities, and emits usage once per record", () => {
    const record = claudeMessage(
      [
        { type: "text", text: "Inspecting" },
        { type: "thinking", thinking: "Recorded summary" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/repo/AGENTS.md" } },
      ],
      {
        message: {
          id: "response-1",
          role: "assistant",
          content: [
            { type: "text", text: "Inspecting" },
            { type: "thinking", thinking: "Recorded summary" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "/repo/AGENTS.md" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
        },
      },
    );
    const events = parse(claude, record);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["message", "reasoning", "tool_call", "usage"],
    );
    assert.equal(events[2]?.nativeId, "message-1");
    assert.equal(events[2]?.parentId, "message-0");
    assert.equal(events[2]?.tool?.callId, "tool-1");
    assert.equal(events[2]?.pointer, "/message/content/2");
    assert.equal(events[3]?.nativeId, "response-1");
    assert.deepEqual(events[3]?.usage, { input: 100, output: 20, cached: 50, scope: "response" });
  });

  it("preserves child stream identity independently from parent session", () => {
    const parsed = claude.parse(
      claudeMessage([{ type: "text", text: "Child" }], { agentId: "agent-2", isSidechain: true }),
      { path: "/subagents/agent-2.jsonl", line: 1 },
    );
    assert.equal(parsed.session.nativeId, "session-1/agent/agent-2");
    assert.equal(parsed.session.parentNativeId, "session-1");
  });

  it("captures recorded skill bodies and leaves references uncaptured", () => {
    const records = fixtureEvents(claude);
    const skill = records.find(
      (event) => event.template === "skill" && event.body.type === "context",
    );
    assert.ok(skill);
    assert.equal(skill.body.type, "context");
    if (skill.body.type === "context") {
      assert.equal(skill.body.captured, true);
      assert.match(skill.body.content, /integer quantities/);
    }
    const [reference] = parse(claude, {
      type: "attachment",
      attachment: { type: "compact_file_reference", filename: "/repo/AGENTS.md" },
    });
    assert.deepEqual(reference?.body, {
      type: "context",
      name: "/repo/AGENTS.md",
      content: "",
      format: "markdown",
      captured: false,
    });
    assert.equal(reference?.evidence[0]?.action, "reference");
  });

  it("reports an explicitly enabled permission mode at its actual pointer", () => {
    const [policy] = parse(claude, {
      type: "attachment",
      attachment: { type: "auto_mode", bypass: true },
    });
    assert.equal(policy?.evidence[0]?.action, "bypass_enabled");
    assert.equal(policy?.evidence[0]?.pointer, "/attachment/bypass");
  });

  it("caps indexed text and evidence without truncating recorded bodies", () => {
    const content = "x".repeat(10000);
    const [message] = parse(claude, claudeMessage([{ type: "text", text: content }]));
    assert.equal(message?.preview.length, 2048);
    assert.deepEqual(message?.body, { type: "text", text: content, format: "markdown" });
    const [listing] = parse(claude, {
      type: "attachment",
      attachment: {
        type: "skill_listing",
        names: Array.from({ length: 200 }, (_, index) => `${index}-${"s".repeat(500)}`),
        content,
      },
    });
    assert.equal(listing?.evidence.length, 64);
    assert.ok(listing?.evidence.every((fact) => fact.label.length <= 256));
  });
});

describe("Codex normalization", () => {
  it("preserves separate tool namespaces and encoded-argument pointers", () => {
    const record = {
      type: "response_item",
      payload: {
        type: "function_call",
        id: "native-1",
        parent_id: "native-0",
        turn_id: "turn-1",
        namespace: "mcp__plugin_inventory",
        name: "lookup",
        call_id: "call-1",
        arguments: '{"sku":"widget"}',
      },
    };
    const [event] = parse(codex, record);
    assert.equal(event?.tool?.name, "mcp__plugin_inventory.lookup");
    assert.equal(event?.nativeId, "native-1");
    assert.equal(event?.parentId, "native-0");
    assert.equal(event?.turnId, "turn-1");
    assert.equal(event?.template, "mcp");
    assert.ok(event?.evidence.every((fact) => fact.pointer === "/payload/namespace"));
    if (event?.body.type === "tool") assert.deepEqual(event.body.input, { sku: "widget" });
    const [bypass] = parse(
      codex,
      codexCall("exec_command", { cmd: "pwd", sandbox_permissions: "require_escalated" }),
    );
    assert.equal(bypass?.evidence[0]?.pointer, "/payload/arguments");
  });

  it("marks nested code requests inferred and never treats code as invocation proof", () => {
    const events = fixtureEvents(codex).filter((event) => event.tool?.name === "functions.exec");
    assert.equal(events.length, 2);
    assert.ok(
      events.every((event) =>
        event.evidence.some(
          (fact) =>
            fact.topic === "search" && fact.action === "requested" && fact.basis === "inferred",
        ),
      ),
    );
    assert.ok(
      events.every((event) =>
        event.evidence.every(
          (fact) => fact.pointer === "/payload/input" && fact.action !== "invoked",
        ),
      ),
    );
    const [web] = parse(
      codex,
      codexCall(
        "functions.exec",
        "text(await tools.web__run({search_query: [{q: 'test'}]}));",
        true,
      ),
    );
    assert.ok(web?.evidence.some((fact) => fact.topic === "search" && fact.basis === "inferred"));
  });

  it("does not invent native skill invocation support for a future fixture event", () => {
    const [event] = parse(codex, {
      type: "event_msg",
      payload: { type: "invoked_skills", invoked_skills: [{ name: "future-skill" }] },
    });
    assert.equal(event?.kind, "diagnostic");
    assert.deepEqual(event?.evidence, []);
    assert.ok(
      fixtureEvents(codex).some((item) =>
        item.evidence.some(
          (fact) =>
            fact.topic === "skills" && fact.action === "requested" && /SKILL.md/.test(fact.label),
        ),
      ),
    );
  });

  it("records multiple usage scopes without flattening cumulative values", () => {
    const events = fixtureEvents(codex).filter((event) => event.kind === "usage");
    assert.ok(
      events.some((event) => event.usage?.scope === "session" && event.usage.input === 1400),
    );
    assert.ok(
      events.some((event) => event.usage?.scope === "response" && event.usage.input === 200),
    );
    assert.ok(events.some((event) => event.usage?.scope === "turn" && event.usage.output === 280));
    assert.ok(events.some((event) => event.nativeId === "fixture-response"));
  });

  it("keeps unreadable reasoning opaque and retains unknown response content", () => {
    const [reasoning] = parse(codex, {
      type: "response_item",
      payload: { type: "reasoning", encrypted_content: "opaque" },
    });
    assert.equal(reasoning?.kind, "reasoning");
    assert.equal(reasoning?.body.type, "data");
    assert.match(reasoning?.preview ?? "", /No readable reasoning/);
    const [unknown] = parse(codex, {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "future_block", nested: true }],
      },
    });
    assert.deepEqual(unknown?.body, {
      type: "data",
      value: { type: "future_block", nested: true },
    });
    assert.equal(unknown?.pointer, "/payload/content/0");
  });
});

describe("evidence false positives", () => {
  it("keeps ordinary assistant and user examples out of recorded context", () => {
    const examples = [
      "Example README:\n## Available skills\n- imaginary: Example only\n## Available plugins\n- imaginary-plugin: Example only",
      "Use this sample:\n<INSTRUCTIONS>\nAGENTS.md example\n</INSTRUCTIONS>",
    ];
    for (const text of examples) {
      for (const role of ["assistant", "user"] as const) {
        const cases = [
          {
            adapter: claude,
            record: { type: role, message: { role, content: [{ type: "text", text }] } },
          },
          {
            adapter: codex,
            record: {
              type: "response_item",
              payload: { type: "message", role, content: [{ type: "output_text", text }] },
            },
          },
        ];
        for (const { adapter, record } of cases) {
          const [event] = parse(adapter, record);
          assert.equal(event?.kind, "message");
          assert.deepEqual(event?.evidence, []);
        }
      }
    }
  });

  it("preserves authoritative and provider-injected instructions and catalogs", () => {
    const text = "# AGENTS.md\nRepository instructions\n## Available skills\n- review: Review code";
    const cases = [
      ...["developer", "system"].map((role) => ({
        adapter: codex,
        record: {
          type: "response_item",
          payload: { type: "message", role, content: [{ type: "input_text", text }] },
        },
      })),
      ...[
        `<system-reminder>\n${text}\n</system-reminder>`,
        `# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`,
      ].map((content) => ({
        adapter: claude,
        record: { type: "user", message: { role: "user", content } },
      })),
    ];
    for (const { adapter, record } of cases) {
      const [event] = parse(adapter, record);
      assert.equal(event?.kind, "context");
      assert.ok(
        event?.evidence.some(
          (fact) =>
            fact.topic === "instructions" && fact.action === "loaded" && fact.basis === "recorded",
        ),
      );
      assert.ok(
        event?.evidence.some(
          (fact) =>
            fact.topic === "skills" && fact.action === "available" && fact.basis === "recorded",
        ),
      );
      event?.evidence.forEach((fact) => resolvePointer(record, fact.pointer));
    }
    const [plainCatalog] = parse(claude, {
      type: "user",
      message: { role: "user", content: "## Available plugins\n- example: A supplied catalog" },
    });
    assert.deepEqual(
      plainCatalog?.evidence.map(({ action, basis }) => ({ action, basis })),
      [{ action: "available", basis: "inferred" }],
    );
  });

  it("does not mark prose, ordinary OS errors, or approval policy as sandbox blocks", () => {
    const records = [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "The phrase Sandbox denied is documented here. Please edit AGENTS.md.",
            },
          ],
        },
      },
      {
        type: "turn_context",
        payload: { approval_policy: "never", sandbox_policy: { type: "workspace-write" } },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "x",
          output: "Permission denied: database is read-only",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "x",
          output: "No sandbox denied this request. Process exited with code 0",
        },
      },
    ];
    assert.ok(
      records
        .flatMap((record) => parse(codex, record))
        .every(
          (event) =>
            !event.evidence.some(
              (fact) => fact.action === "blocked" || fact.action === "bypass_enabled",
            ),
        ),
    );
  });

  it("ignores nested calls inside strings and comments", () => {
    const code =
      'const text = "tools.mcp__parallel__web_search({})"; // tools.web__run({})\n/* tools.exec_command({cmd: "parallel-cli search ignored"}) */';
    const [event] = parse(codex, codexCall("functions.exec", code, true));
    assert.deepEqual(event?.evidence, []);
  });

  it("ignores tool names inside regex literals and resumes after the literal", () => {
    for (const pattern of [
      "/tools.web__run({})/",
      "/[/]tools.web__run({})/gi",
      String.raw`/prefix\/tools.web__run({})/`,
    ]) {
      const code = `const pattern = ${pattern};`;
      const [literal] = parse(codex, codexCall("functions.exec", code, true));
      assert.deepEqual(literal?.evidence, []);
      const [called] = parse(
        codex,
        codexCall("functions.exec", `${code} await tools.web__run({});`, true),
      );
      assert.equal(called?.evidence.length, 1);
      assert.equal(called?.evidence[0]?.topic, "search");
      assert.equal(called?.evidence[0]?.basis, "inferred");
    }
  });

  it("keeps explicit successful results successful when stdout quotes an approval denial", () => {
    const output = "Approval denied by test fixture";
    const records = [
      {
        adapter: claude,
        record: claudeMessage([
          { type: "tool_result", tool_use_id: "success", content: output, is_error: false },
        ]),
      },
      ...[
        { exit_code: 0, output },
        { is_error: false, output },
      ].map((value) => ({
        adapter: codex,
        record: {
          type: "response_item",
          payload: { type: "function_call_output", call_id: "success", output: value },
        },
      })),
    ];
    for (const { adapter, record } of records) {
      const [result] = parse(adapter, record);
      assert.equal(result?.tool?.status, "success");
      assert.ok(!result?.evidence.some((fact) => fact.action === "blocked"));
    }
  });

  it("does not mistake echoed commands, heredoc contents, or unrelated MCP tools for search", () => {
    const commands = [
      "echo 'parallel-cli search ignored'",
      "cat <<'EOF'\nparallel-cli search ignored\nEOF",
      "parallel-cli summarize report.txt",
    ];
    const events = commands.flatMap((cmd) => parse(codex, codexCall("exec_command", { cmd })));
    events.push(...parse(codex, codexCall("mcp__parallel__account_info", {})));
    assert.ok(events.every((event) => !event.evidence.some((fact) => fact.topic === "search")));
  });
});

describe("additional recorded provider variants", () => {
  it("reads Claude attribution and tool-result agent metadata without claiming bypass approval", () => {
    const record = claudeMessage([{ type: "text", text: "Attributed output" }], {
      attributionSkill: "plugin:review",
      attributionPlugin: "plugin",
      attributionAgent: "reviewer",
    });
    const [attributed] = parse(claude, record);
    assert.ok(
      attributed?.evidence.some(
        (fact) =>
          fact.topic === "skills" && fact.label === "plugin:review" && fact.action === "invoked",
      ),
    );
    assert.ok(
      attributed?.evidence.some(
        (fact) => fact.topic === "plugins" && fact.label === "plugin" && fact.action === "invoked",
      ),
    );
    attributed?.evidence.forEach((fact) => resolvePointer(record, fact.pointer));
    const result = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "agent-1", content: "Completed", is_error: false },
        ],
      },
      toolUseResult: { agentId: "child-1", dangerouslyDisableSandbox: true },
    };
    const [event] = parse(claude, result);
    assert.ok(
      event?.evidence.some((fact) => fact.topic === "subagents" && fact.action === "result"),
    );
    assert.ok(
      event?.evidence.some(
        (fact) => fact.topic === "sandbox" && fact.action === "bypass_requested",
      ),
    );
    assert.ok(!event?.evidence.some((fact) => fact.action === "bypass_enabled"));
    event?.evidence.forEach((fact) => resolvePointer(result, fact.pointer));
  });

  it("supports Claude server search blocks and Codex MCP completion records", () => {
    const [search] = parse(
      claude,
      claudeMessage([
        {
          type: "server_tool_use",
          id: "search-1",
          name: "web_search",
          input: { query: "example" },
        },
      ]),
    );
    assert.equal(search?.template, "search");
    const records = [
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "McpToolCall",
            id: "mcp-1",
            call_id: "call-1",
            server: "parallel",
            tool: "web_search",
            status: "completed",
            arguments: { query: "test" },
            result: "One result",
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "call-2",
          invocation: { server: "parallel", tool: "web_search", arguments: { query: "test" } },
          result: { results: [] },
        },
      },
    ];
    for (const record of records) {
      const [event] = parse(codex, record);
      assert.equal(event?.kind, "tool_result");
      assert.equal(event?.template, "search");
      assert.ok(event?.evidence.some((fact) => fact.topic === "mcp" && fact.action === "result"));
      assert.ok(
        event?.evidence.some((fact) => fact.topic === "search" && fact.action === "result"),
      );
      event?.evidence.forEach((fact) => resolvePointer(record, fact.pointer));
    }
  });

  it("lets recorded MCP errors override a completed call status", () => {
    for (const isError of [true, false]) {
      const result = { isError, content: [{ type: "text", text: "Recorded result" }] };
      const fields = {
        server: "test",
        tool: "read",
        status: "completed",
        call_id: "mcp-result",
        result,
      };
      for (const payload of [
        { type: "mcp_tool_call_end", ...fields },
        { type: "item_completed", item: { type: "McpToolCall", ...fields } },
      ]) {
        const record = { type: "event_msg", payload };
        const [event] = parse(codex, record);
        assert.equal(event?.tool?.status, isError ? "error" : "success");
        assert.equal(event?.body.type, "tool");
        if (event?.body.type === "tool") assert.deepEqual(event.body.output, result);
        assert.ok(!event?.evidence.some((fact) => fact.action === "blocked"));
        event?.evidence.forEach((fact) => resolvePointer(record, fact.pointer));
      }
    }
  });

  it("distinguishes successful structured skill reads, generic failures, and explicit sandbox denial", () => {
    const completed = (fields: Record<string, unknown>) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: "command-1",
          parsed_cmd: [{ type: "read", path: "/repo/skills/review/SKILL.md" }],
          ...fields,
        },
      },
    });
    const success = completed({
      status: "completed",
      exit_code: 0,
      aggregated_output: "Recorded skill body",
    });
    const [read] = parse(codex, success);
    assert.equal(read?.tool?.status, "success");
    assert.ok(read?.evidence.some((fact) => fact.topic === "skills" && fact.action === "loaded"));
    assert.ok(!read?.evidence.some((fact) => fact.action === "invoked"));
    read?.evidence.forEach((fact) => resolvePointer(success, fact.pointer));
    const [failed] = parse(
      codex,
      completed({
        status: "failed",
        exit_code: 1,
        aggregated_output: "Operation not permitted (os error 1)",
      }),
    );
    assert.equal(failed?.tool?.status, "error");
    assert.ok(!failed?.evidence.some((fact) => fact.action === "blocked"));
    const [blocked] = parse(
      codex,
      completed({
        status: "failed",
        exit_code: 1,
        aggregated_output: "Sandbox denied write to /restricted/file",
      }),
    );
    assert.ok(blocked?.evidence.some((fact) => fact.action === "blocked"));
  });

  it("preserves explicit subagent activity and native search-result records", () => {
    const [agent] = parse(codex, {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        agent_thread_id: "child-1",
        agent_path: "/root/reviewer",
      },
    });
    assert.equal(agent?.template, "subagent");
    assert.equal(agent?.evidence[0]?.label, "child-1");
    const [search] = parse(codex, {
      type: "event_msg",
      payload: { type: "web_search_end", call_id: "call-1", query: "example", results: [] },
    });
    assert.equal(search?.template, "search");
    assert.equal(search?.tool?.callId, "call-1");
    assert.equal(search?.evidence[0]?.action, "result");
  });

  it("bounds content fanout and keeps excess blocks inspectable", () => {
    const blocks = Array.from({ length: 2000 }, (_, index) => ({
      type: "text",
      text: `Part ${index}`,
    }));
    for (const [adapter, record] of [
      [claude, claudeMessage(blocks)],
      [
        codex,
        { type: "response_item", payload: { type: "message", role: "assistant", content: blocks } },
      ],
    ] as const) {
      const events = parse(adapter, record);
      assert.equal(events.length, 257);
      assert.equal(events.at(-1)?.kind, "diagnostic");
      assert.deepEqual(events.at(-1)?.body, { type: "data", value: blocks });
      resolvePointer(record, events.at(-1)!.pointer);
    }
  });

  it("does not turn successful tool content into a sandbox failure", () => {
    const record = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "Sandbox denied write is an example phrase in this document.",
            is_error: false,
          },
        ],
      },
    };
    const [result] = parse(claude, record);
    assert.equal(result?.tool?.status, "success");
    assert.ok(!result?.evidence.some((fact) => fact.action === "blocked"));
  });

  it("labels a plugin skill path as a requested read rather than a search or invocation", () => {
    const [event] = parse(
      codex,
      codexCall("exec_command", {
        cmd: "cat /home/test/.codex/plugins/cache/parallel-web/parallel/1.0/skills/parallel-web-search/SKILL.md",
      }),
    );
    assert.ok(
      event?.evidence.some(
        (fact) =>
          fact.topic === "plugins" && fact.action === "requested" && fact.basis === "inferred",
      ),
    );
    assert.ok(
      !event?.evidence.some((fact) => fact.topic === "search" || fact.action === "invoked"),
    );
  });
});
