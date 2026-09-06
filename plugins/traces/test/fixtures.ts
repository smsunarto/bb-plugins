type FixtureProvider = "claude-code" | "codex";

const cwd = "/workspace/shop";
const title = "Fix checkout validation";
const instructions =
  "# AGENTS.md\nValidate checkout quantities before charging. Run checkout tests.\n\n# CLAUDE.md\nUse the repository formatter. Keep error messages concise.";
const skillListing =
  "## Available skills\n- checkout-review: Review checkout validation. (file: /workspace/shop/.agents/skills/checkout-review/SKILL.md)\n- unused-design: Available but not invoked. (file: /workspace/shop/.agents/skills/unused-design/SKILL.md)";
const pluginListing =
  "## Available plugins\n- inventory: Inventory lookup through mcp__plugin_inventory__lookup.\n- unused-calendar: Available but not invoked.";
const patch =
  "*** Begin Patch\n*** Update File: /workspace/shop/src/checkout.ts\n@@\n-  return quantity > 0;\n+  return Number.isInteger(quantity) && quantity > 0;\n*** End Patch";
const diff =
  "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-return quantity > 0;\n+return Number.isInteger(quantity) && quantity > 0;";

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 8, 6, 10, 0, index)).toISOString();
}

function claudeRecords(): unknown[] {
  const records: unknown[] = [];
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const add = (type: string, fields: Record<string, unknown>) => {
    const index = records.length;
    records.push({
      type,
      uuid: `claude-event-${index}`,
      parentUuid: index === 0 ? null : `claude-event-${index - 1}`,
      sessionId,
      cwd,
      timestamp: timestamp(index),
      ...fields,
    });
  };
  const message = (role: "user" | "assistant", content: unknown[], extra = {}) =>
    add(role, { message: { role, content, ...extra } });
  const tool = (name: string, input: Record<string, unknown>, output: string, isError = false) => {
    const id = `claude-tool-${records.length}`;
    message("assistant", [{ type: "tool_use", id, name, input }]);
    message("user", [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }]);
  };

  add("system", {
    subtype: "init",
    tools: ["Read", "Write", "Edit", "Bash", "Skill", "Agent", "Task", "WebSearch"],
    model: "claude-fixture-model",
    permissionMode: "default",
    mcp_servers: [{ name: "inventory", status: "connected" }],
    plugins: [{ name: "inventory", path: "/workspace/shop/.plugins/inventory" }],
  });
  add("custom-title", { customTitle: title });
  message("user", [{ type: "text", text: title }]);
  message("user", [
    { type: "text", text: `<system-reminder>\n${instructions}\n</system-reminder>` },
  ]);
  add("attachment", {
    attachment: {
      type: "skill_listing",
      content: skillListing,
      skillCount: 2,
      isInitial: true,
      names: ["checkout-review", "unused-design"],
    },
  });
  add("attachment", {
    attachment: {
      type: "deferred_tools_delta",
      addedNames: ["mcp__plugin_inventory__lookup"],
      addedLines: ["mcp__plugin_inventory__lookup: Look up inventory."],
      removedNames: [],
      wireHiddenNames: [],
      readdedNames: [],
      pendingMcpServers: [],
      needsAuthMcpServers: [],
      failedMcpServers: [],
    },
  });
  add("attachment", {
    attachment: {
      type: "agent_listing_delta",
      addedTypes: ["Explore"],
      addedLines: ["Explore: Inspect the repository."],
      removedTypes: [],
      isInitial: true,
      showConcurrencyNote: true,
    },
  });
  add("attachment", {
    attachment: {
      type: "mcp_instructions_delta",
      addedNames: ["inventory"],
      addedBlocks: ["Use inventory lookup to check stock."],
      removedNames: [],
    },
  });
  add("attachment", {
    attachment: {
      type: "sandbox_instructions",
      content:
        "Filesystem writes are restricted to /workspace/shop. Network access requires approval. This policy text is not a denial.",
    },
  });
  add("attachment", {
    attachment: {
      type: "auto_mode",
      autoModeConsentFlow: false,
      bashFirst: false,
      bashFirstSteer: "",
      steerOnly: false,
      bypass: false,
    },
  });
  message("user", [{ type: "text", text: pluginListing }]);
  message("user", [
    {
      type: "text",
      text: "Sandbox policy: filesystem writes are restricted to /workspace/shop. Network access requires approval. This policy text is not a denial.",
    },
  ]);
  message("assistant", [
    {
      type: "thinking",
      thinking:
        "I should inspect the existing validation and add coverage for fractional quantities.",
      signature: "synthetic-signature",
    },
  ]);
  tool(
    "Read",
    { file_path: "/workspace/shop/src/checkout.ts" },
    "export const validQuantity = (quantity: number) => quantity > 0;",
  );
  tool(
    "Skill",
    { skill: "checkout-review", args: "quantity validation" },
    "Review integer quantities, zero, and negative quantities.",
  );
  add("attachment", {
    attachment: {
      type: "invoked_skills",
      skills: [
        {
          name: "checkout-review",
          path: "/workspace/shop/.agents/skills/checkout-review/SKILL.md",
          content: "Review integer quantities, zero, and negative quantities.",
        },
      ],
    },
  });
  tool("mcp__plugin_inventory__lookup", { sku: "sample-widget" }, '{"available":12}');
  tool(
    "mcp__parallel__web_search",
    { query: "JavaScript integer quantity validation" },
    '{"results":[{"title":"Number.isInteger","url":"https://example.com/integer"}]}',
  );
  tool(
    "WebSearch",
    { query: "JavaScript Number.isInteger" },
    "Search returned an integer validation reference.",
  );
  tool(
    "Bash",
    {
      command: "parallel-cli search 'integer checkout validation'",
      description: "Find validation references",
    },
    "One validation reference found.",
  );
  tool(
    "Agent",
    {
      description: "Review quantity validation",
      subagent_type: "Explore",
      prompt: "Inspect checkout validation edge cases.",
    },
    "agentId: fixture-reviewer\nFractional quantities should be rejected.",
  );
  tool(
    "Task",
    {
      description: "Review checkout tests",
      subagent_type: "general-purpose",
      prompt: "Suggest focused checkout tests.",
    },
    "agentId: fixture-test-reviewer\nCover zero, negative, and fractional quantities.",
  );
  tool(
    "Bash",
    { command: "printf sample > /restricted/probe.txt" },
    "Sandbox denied write to /restricted/probe.txt: Operation not permitted.",
    true,
  );
  tool(
    "Bash",
    {
      command: "printf sample > /restricted/probe.txt",
      dangerouslyDisableSandbox: true,
      description: "Request approval for sandbox bypass",
    },
    "Permission request denied by user.",
    true,
  );
  tool(
    "Write",
    {
      file_path: "/workspace/shop/src/checkout.test.ts",
      content: "expect(validQuantity(1.5)).toBe(false);\n",
    },
    "File created.",
  );
  tool(
    "Edit",
    {
      file_path: "/workspace/shop/src/checkout.ts",
      old_string: "quantity > 0",
      new_string: "Number.isInteger(quantity) && quantity > 0",
    },
    "File updated.",
  );
  tool("Bash", { command: "git diff -- src/checkout.ts" }, diff);
  tool("Bash", { command: "bun test src/checkout.test.ts" }, "3 pass\n0 fail");
  message(
    "assistant",
    [
      {
        type: "text",
        text: "Checkout now rejects fractional quantities. The checkout tests pass.",
      },
    ],
    {
      model: "claude-fixture-model",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1200,
        output_tokens: 240,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 0,
      },
    },
  );
  add("system", { subtype: "turn_duration", durationMs: 4200 });
  return records;
}

function codexRecords(): unknown[] {
  const records: unknown[] = [];
  const add = (type: string, payload: Record<string, unknown>) => {
    records.push({ timestamp: timestamp(records.length), ordinal: records.length, type, payload });
  };
  const response = (payload: Record<string, unknown>) => add("response_item", payload);
  const message = (role: "user" | "assistant" | "developer", text: string) =>
    response({
      type: "message",
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    });
  const tool = (name: string, args: Record<string, unknown>, output: string) => {
    const call_id = `codex-call-${records.length}`;
    response({ type: "function_call", name, call_id, arguments: JSON.stringify(args) });
    response({ type: "function_call_output", call_id, output });
  };
  const customTool = (name: string, input: string, output: string) => {
    const call_id = `codex-custom-${records.length}`;
    response({ type: "custom_tool_call", status: "completed", name, call_id, input });
    response({ type: "custom_tool_call_output", call_id, output });
  };

  add("session_meta", {
    id: "22222222-2222-4222-8222-222222222222",
    timestamp: timestamp(0),
    cwd,
    originator: "codex_cli_rs",
    cli_version: "0.0.0-fixture",
    source: "cli",
    model_provider: "openai",
    base_instructions: { text: "Help maintain the checkout application." },
  });
  add("turn_context", {
    turn_id: "fixture-turn-1",
    cwd,
    approval_policy: "on-request",
    sandbox_policy: { type: "workspace-write", writable_roots: [cwd], network_access: false },
    model: "codex-fixture-model",
    effort: "medium",
  });
  add("event_msg", {
    type: "task_started",
    turn_id: "fixture-turn-1",
    model_context_window: 128000,
  });
  message("developer", `${instructions}\n\n${skillListing}\n\n${pluginListing}`);
  message("user", title);
  add("event_msg", {
    type: "user_message",
    message: title,
    images: [],
    local_images: [],
    text_elements: [],
  });
  response({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "I should check integer validation and its tests." }],
    content: null,
    encrypted_content: "synthetic-encrypted-content",
  });
  message("assistant", "I will inspect checkout validation and run its focused tests.");
  tool(
    "exec_command",
    { cmd: "cat /workspace/shop/AGENTS.md /workspace/shop/CLAUDE.md" },
    instructions,
  );
  tool(
    "exec_command",
    { cmd: "cat /workspace/shop/.agents/skills/checkout-review/SKILL.md" },
    "Review integer quantities, zero, and negative quantities.",
  );
  add("event_msg", {
    type: "invoked_skills",
    invoked_skills: [
      { name: "checkout-review", path: "/workspace/shop/.agents/skills/checkout-review/SKILL.md" },
    ],
  });
  tool("mcp__plugin_inventory__lookup", { sku: "sample-widget" }, '{"available":12}');
  response({
    type: "function_call",
    namespace: "mcp__plugin_inventory",
    name: "lookup",
    call_id: "codex-separated-namespace",
    arguments: '{"sku":"sample-widget"}',
  });
  response({
    type: "function_call_output",
    call_id: "codex-separated-namespace",
    output: '{"available":12}',
  });
  tool(
    "mcp__parallel__web_search",
    { query: "JavaScript integer validation" },
    '{"results":[{"title":"Number.isInteger","url":"https://example.com/integer"}]}',
  );
  response({
    type: "web_search_call",
    id: "fixture-web-search",
    status: "completed",
    action: { type: "search", query: "JavaScript Number.isInteger" },
  });
  tool(
    "exec_command",
    { cmd: "parallel-cli search 'integer checkout validation'" },
    "One validation reference found.",
  );
  customTool(
    "functions.exec",
    'const result = await tools.mcp__parallel__web_search({query: "quantity validation"}); text(result);',
    '{"results":[{"title":"Quantity validation","url":"https://example.com/quantities"}]}',
  );
  customTool(
    "functions.exec",
    'text(await tools.exec_command({cmd: "parallel-cli search integer-validation"}));',
    "One validation reference found.",
  );
  tool(
    "spawn_agent",
    { agent_type: "explorer", message: "Inspect checkout validation edge cases." },
    '{"agent_id":"fixture-reviewer","nickname":"Reviewer"}',
  );
  tool(
    "wait_agent",
    { ids: ["fixture-reviewer"], timeout_ms: 1000 },
    '{"status":{"fixture-reviewer":{"completed":"Reject fractional quantities."}},"timed_out":false}',
  );
  tool(
    "exec_command",
    { cmd: "printf sample > /restricted/probe.txt" },
    "Command failed with exit code 1: Sandbox denied write to /restricted/probe.txt: Operation not permitted.",
  );
  tool(
    "exec_command",
    {
      cmd: "printf sample > /restricted/probe.txt",
      sandbox_permissions: "require_escalated",
      justification: "May I perform the fixture write outside the workspace?",
    },
    "Request rejected: approval denied by user.",
  );
  tool(
    "exec_command",
    { cmd: "cat src/checkout.ts", workdir: cwd },
    "export const validQuantity = (quantity: number) => quantity > 0;",
  );
  customTool(
    "apply_patch",
    patch,
    "Success. Updated the following files:\nM /workspace/shop/src/checkout.ts",
  );
  customTool(
    "apply_patch",
    "*** Begin Patch\n*** Add File: /workspace/shop/src/checkout.test.ts\n+expect(validQuantity(1.5)).toBe(false);\n*** End Patch",
    "Success. Updated the following files:\nA /workspace/shop/src/checkout.test.ts",
  );
  tool("exec_command", { cmd: "git diff -- src/checkout.ts", workdir: cwd }, diff);
  tool(
    "exec_command",
    { cmd: "bun test src/checkout.test.ts", workdir: cwd },
    "Process exited with code 0\n3 pass\n0 fail",
  );
  add("event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 1400,
        cached_input_tokens: 300,
        output_tokens: 280,
        reasoning_output_tokens: 100,
        total_tokens: 1680,
      },
      last_token_usage: {
        input_tokens: 200,
        cached_input_tokens: 0,
        output_tokens: 80,
        reasoning_output_tokens: 20,
        total_tokens: 280,
      },
      model_context_window: 128000,
    },
    rate_limits: null,
  });
  message("assistant", "Checkout now rejects fractional quantities. The checkout tests pass.");
  add("token_usage_record", {
    thread_id: "fixture-thread",
    turn_id: "fixture-turn-1",
    session_id: "22222222-2222-4222-8222-222222222222",
    root_turn_id: "fixture-turn-1",
    response_id: "fixture-response",
    usage: {
      input_tokens: 200,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 80,
      reasoning_output_tokens: 20,
      total_tokens: 280,
    },
    turn_token_usage: {
      input_tokens: 1400,
      cached_input_tokens: 300,
      cache_write_input_tokens: 0,
      output_tokens: 280,
      reasoning_output_tokens: 100,
      total_tokens: 1680,
    },
    thread_token_usage: {
      input_tokens: 1400,
      cached_input_tokens: 300,
      cache_write_input_tokens: 0,
      output_tokens: 280,
      reasoning_output_tokens: 100,
      total_tokens: 1680,
    },
  });
  add("event_msg", {
    type: "task_complete",
    turn_id: "fixture-turn-1",
    last_agent_message: "Checkout now rejects fractional quantities. The checkout tests pass.",
  });
  return records;
}

export function fixtureRecords(provider: FixtureProvider): unknown[] {
  return provider === "claude-code" ? claudeRecords() : codexRecords();
}

export function fixtureJsonl(provider: FixtureProvider): string {
  return (
    fixtureRecords(provider)
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n"
  );
}

export function robustnessFixtures(provider: FixtureProvider) {
  const records = fixtureRecords(provider);
  const first = JSON.stringify(records[0]);
  const second = JSON.stringify(records[1]);
  const midpoint = Math.floor(second.length / 2);
  return {
    malformedBetweenRecords: `${first}\n{not valid json}\n${second}\n`,
    partialLine: `${first}\n${second.slice(0, midpoint)}`,
    partialLineRemainder: `${second.slice(midpoint)}\n`,
    completeWithoutNewline: `${first}\n${second}`,
    nonObjectRecords: `${first}\nnull\n[]\n42\n"text"\n${second}\n`,
    unknownEvent:
      JSON.stringify({
        timestamp: timestamp(0),
        type: "future_event",
        payload: { feature: "preserve raw source" },
      }) + "\n",
    unsupportedProvider:
      JSON.stringify({
        provider: "unsupported-fixture-provider",
        sessionId: "unsupported-fixture-session",
        type: "message",
        role: "user",
        content: title,
      }) + "\n",
  };
}
