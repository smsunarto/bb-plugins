import type {
  ParsedEvent,
  ParsedRecord,
  SessionPatch,
  TraceAdapter,
  TraceEvidence,
} from "../model";
import {
  contentText,
  diagnostic,
  event,
  fact,
  finite,
  json,
  MAX_PARTS,
  object,
  overflowParts,
  pointer,
  rootPath,
  string,
  textEvent,
  timestamp,
  type ObjectRecord,
} from "./common";
import { toolCall, toolEvidence, toolResult } from "./tools";
import { userPromptTitle } from "./title";

function sessionPatch(payload: ObjectRecord): SessionPatch {
  const session: SessionPatch = {};
  const cwd = string(payload.cwd);
  const model = string(payload.model);
  if (cwd) session.cwd = cwd;
  if (model) session.model = model;
  return session;
}

function usageEvent(
  record: ObjectRecord,
  value: unknown,
  at: string,
  scope: "response" | "turn" | "session",
): ParsedEvent | null {
  const usage = object(value);
  const input = finite(usage.input_tokens);
  const output = finite(usage.output_tokens);
  const cached = finite(usage.cached_input_tokens);
  if (input === null && output === null && cached === null) return null;
  return event(record, {
    kind: "usage",
    title: `${scope[0]!.toUpperCase()}${scope.slice(1)} usage`,
    preview: json(usage),
    template: "usage",
    pointer: at,
    usage: { input, output, cached, scope },
    body: { type: "data", value: usage },
  });
}

function sessionEvents(record: ObjectRecord, payload: ObjectRecord): ParsedRecord {
  const session = sessionPatch(payload);
  const nativeId = string(payload.session_id) ?? string(payload.id);
  const startedAt = timestamp(payload.timestamp) ?? timestamp(record.timestamp);
  const spawn = object(object(object(payload.source).subagent).thread_spawn);
  const parent =
    string(payload.parent_session_id) ??
    string(payload.parent_thread_id) ??
    string(spawn.parent_thread_id);
  if (nativeId) session.nativeId = nativeId;
  if (startedAt !== null) session.startedAt = startedAt;
  if (parent) session.parentNativeId = parent;
  const facts: TraceEvidence[] = parent
    ? [
        fact(
          "subagents",
          "reference",
          `Parent session ${parent}`,
          payload.parent_session_id
            ? "/payload/parent_session_id"
            : payload.parent_thread_id
              ? "/payload/parent_thread_id"
              : "/payload/source/subagent/thread_spawn/parent_thread_id",
        ),
      ]
    : [];
  if (Array.isArray(payload.dynamic_tools)) {
    payload.dynamic_tools.slice(0, 64).forEach((value, index) => {
      const tool = object(value);
      const name = string(tool.name);
      if (name)
        facts.push(
          ...toolEvidence(
            name,
            {},
            {
              at: "/payload",
              inputAt: "/payload",
              nameAt: pointer(`/payload/dynamic_tools/${index}`, "name"),
              action: "available",
            },
          ).facts,
        );
    });
  }
  const events = [
    event(record, {
      kind: "context",
      title: "Session metadata",
      preview: string(payload.cwd) ?? nativeId ?? "Recorded session metadata",
      pointer: "/payload",
      template: "context",
      evidence: facts,
      body: { type: "data", value: payload },
    }),
  ];
  const instructions =
    typeof payload.base_instructions === "string"
      ? payload.base_instructions
      : string(object(payload.base_instructions).text);
  if (instructions !== null && instructions !== undefined) {
    const at =
      typeof payload.base_instructions === "string"
        ? "/payload/base_instructions"
        : "/payload/base_instructions/text";
    events.push(
      event(record, {
        kind: "context",
        role: "system",
        title: "Base instructions",
        preview: instructions,
        pointer: at,
        template: "instructions",
        evidence: [fact("instructions", "loaded", "Recorded base instructions", at)],
        body: {
          type: "context",
          name: "Base instructions",
          content: instructions,
          format: "markdown",
          captured: true,
        },
      }),
    );
  }
  return { session, events };
}

function responseMessage(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const role = ["user", "assistant", "system", "developer", "tool"].includes(String(payload.role))
    ? (payload.role as ParsedEvent["role"])
    : null;
  if (typeof payload.content === "string")
    return [textEvent(record, payload.content, role, "/payload/content")];
  if (!Array.isArray(payload.content) || !payload.content.length) return [];
  const events = payload.content.slice(0, MAX_PARTS).map((value, index) => {
    const block = object(value);
    const at = pointer("/payload/content", index);
    if (
      ["input_text", "output_text", "text"].includes(String(block.type)) &&
      typeof block.text === "string"
    ) {
      return textEvent(record, block.text, role, `${at}/text`);
    }
    return event(record, {
      title: `Recorded ${string(block.type) ?? "content"}`,
      preview: string(block.type) ?? "Unrecognized content block",
      pointer: at,
      body: { type: "data", value },
    });
  });
  return [...events, ...overflowParts(record, payload.content, "/payload/content")];
}

function responseReasoning(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const summary = contentText(payload.summary);
  const text = summary || contentText(payload.content);
  return [
    event(record, {
      kind: "reasoning",
      role: "assistant",
      title: "Recorded reasoning",
      preview: text || "No readable reasoning recorded",
      template: "reasoning",
      pointer: summary ? "/payload/summary" : "/payload",
      body: text ? { type: "text", text, format: "markdown" } : { type: "data", value: payload },
    }),
  ];
}

function responseCall(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const rawName = string(payload.name);
  if (!rawName) return [diagnostic(record, "Tool call has no recorded name")];
  const namespace = string(payload.namespace);
  const name = namespace ? `${namespace}.${rawName}` : rawName;
  const custom = payload.type === "custom_tool_call";
  return [
    toolCall(record, {
      name,
      callId: string(payload.call_id),
      value: custom ? payload.input : payload.arguments,
      at: "/payload",
      inputAt: custom ? "/payload/input" : "/payload/arguments",
      nameAt: namespace ? "/payload/namespace" : "/payload/name",
      code: custom && ["exec", "functions.exec"].includes(name),
    }),
  ];
}

function responseResult(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  return [
    toolResult(record, {
      value: payload.output,
      callId: string(payload.call_id),
      at: "/payload",
      outputAt: "/payload/output",
    }),
  ];
}

function responseSearch(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const action = object(payload.action);
  const statuses = { completed: "success", failed: "error" } as const;
  const status = statuses[payload.status as keyof typeof statuses] ?? "requested";
  return [
    event(record, {
      kind: "tool_call",
      role: "assistant",
      title: "Native web search",
      preview: string(action.query) ?? json(action),
      pointer: "/payload",
      template: "search",
      tool: { name: "web_search", callId: string(payload.id), status },
      evidence: [fact("search", "invoked", "Native web search", "/payload/type")],
      body: { type: "tool", input: payload.action, output: null, text: string(action.query) },
    }),
  ];
}

function responseAgentMessage(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const text = contentText(payload.content);
  return [
    event(record, {
      kind: "message",
      role: "assistant",
      title: "Agent message",
      preview: text || "Recorded agent communication",
      pointer: "/payload",
      template: "subagent",
      evidence: [fact("subagents", "result", "Recorded agent communication", "/payload/type")],
      body: text ? { type: "text", text, format: "markdown" } : { type: "data", value: payload },
    }),
  ];
}

type RecordReader = (record: ObjectRecord, payload: ObjectRecord) => ParsedEvent[];
const responseReaders: Readonly<Record<string, RecordReader>> = {
  message: responseMessage,
  reasoning: responseReasoning,
  function_call: responseCall,
  custom_tool_call: responseCall,
  function_call_output: responseResult,
  custom_tool_call_output: responseResult,
  web_search_call: responseSearch,
  agent_message: responseAgentMessage,
};

function responseEvents(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const type = string(payload.type) ?? "unknown";
  const events = responseReaders[type]?.(record, payload) ?? [];
  return events.length ? events : [diagnostic(record, `Unrecognized Codex response: ${type}`)];
}

function mcpResult(
  record: ObjectRecord,
  value: ObjectRecord,
  at: string,
  resultValue: unknown,
): ParsedEvent | null {
  const invocation = object(value.invocation);
  const server = string(value.server) ?? string(invocation.server);
  const tool = string(value.tool) ?? string(invocation.tool);
  if (!server || !tool) return null;
  const name = `mcp__${server}__${tool}`;
  const description = toolEvidence(
    name,
    {},
    {
      at,
      inputAt: at,
      nameAt: value.server !== undefined ? `${at}/server` : `${at}/invocation/server`,
      action: "result",
    },
  );
  return event(record, {
    kind: "tool_result",
    role: "tool",
    title: name,
    preview: contentText(resultValue) || json(resultValue),
    pointer: at,
    nativeId: string(value.id) ?? string(object(record.payload).id),
    template: description.template,
    evidence: description.facts,
    tool: {
      name,
      callId: string(value.call_id),
      status:
        object(resultValue).isError === true ||
        value.status === "failed" ||
        (value.error !== undefined && value.error !== null)
          ? "error"
          : value.status === "completed"
            ? "success"
            : "unknown",
    },
    body: {
      type: "tool",
      input: value.arguments ?? invocation.arguments ?? null,
      output: resultValue,
      text: typeof resultValue === "string" ? resultValue : null,
    },
  });
}

function completedItem(record: ObjectRecord, payload: ObjectRecord): ParsedEvent | null {
  const item = object(payload.item);
  const at = "/payload/item";
  if (item.type === "McpToolCall")
    return mcpResult(record, item, at, item.result ?? item.output ?? item);
  if (item.type !== "CommandExecution") return null;
  const result = toolResult(record, {
    value: item,
    callId: string(item.call_id),
    at,
    outputAt: at,
    ...(item.status === "failed" ? { isError: true } : {}),
  });
  const facts = [...result.evidence];
  if (Array.isArray(item.parsed_cmd)) {
    item.parsed_cmd.slice(0, 64).forEach((value, index) => {
      const command = object(value);
      const path = string(command.path);
      if (command.type !== "read" || !path) return;
      const basename = path.split(/[\\/]/).at(-1);
      const topic =
        basename === "SKILL.md"
          ? "skills"
          : basename === "AGENTS.md" || basename === "CLAUDE.md"
            ? "instructions"
            : null;
      if (topic)
        facts.push(
          fact(
            topic,
            result.tool?.status === "success" ? "loaded" : "requested",
            path,
            `${at}/parsed_cmd/${index}/path`,
          ),
        );
    });
  }
  return event(record, {
    ...result,
    title: "Command execution",
    preview:
      string(item.aggregated_output) ??
      string(item.output) ??
      string(item.command) ??
      result.preview,
    nativeId: string(item.id) ?? result.nativeId,
    evidence: facts,
    tool: {
      name: "exec_command",
      callId: string(item.call_id),
      status: result.tool?.status ?? "unknown",
    },
    body: {
      type: "tool",
      input: item.command ?? null,
      output: item.aggregated_output ?? item.output ?? item,
      text: string(item.aggregated_output) ?? string(item.output),
    },
  });
}

function nativeSearchResult(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  return [
    event(record, {
      kind: "tool_result",
      role: "tool",
      title: "Native web result",
      preview: string(payload.query) ?? "Recorded web result",
      template: "search",
      pointer: "/payload",
      tool: {
        name: "web_search",
        callId: string(payload.call_id),
        status: payload.error ? "error" : "unknown",
      },
      evidence: [fact("search", "result", "Native web result", "/payload/type")],
      body: {
        type: "tool",
        input: payload.query ?? null,
        output: payload.results ?? payload,
        text: null,
      },
    }),
  ];
}

function agentActivity(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  return [
    event(record, {
      kind: "context",
      title: "Subagent activity",
      preview:
        string(payload.agent_path) ?? string(payload.agent_thread_id) ?? "Recorded agent activity",
      template: "subagent",
      pointer: "/payload",
      evidence: [
        fact(
          "subagents",
          "result",
          string(payload.agent_thread_id) ?? "Recorded agent activity",
          payload.agent_thread_id !== undefined ? "/payload/agent_thread_id" : "/payload/type",
        ),
      ],
      body: { type: "data", value: payload },
    }),
  ];
}

function tokenCount(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const info = object(payload.info);
  return [
    usageEvent(record, info.total_token_usage, "/payload/info/total_token_usage", "session"),
    usageEvent(record, info.last_token_usage, "/payload/info/last_token_usage", "response"),
  ].filter((item): item is ParsedEvent => item !== null);
}

function turnNotification(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const titles: Readonly<Record<string, string>> = {
    task_started: "Turn started",
    task_complete: "Turn completed",
    turn_aborted: "Turn aborted",
  };
  const type = string(payload.type) ?? "unknown";
  return [
    event(record, {
      kind: "turn",
      title: titles[type] ?? "Turn event",
      preview: string(payload.last_agent_message) ?? type,
      pointer: "/payload",
      template: "turn",
      body: { type: "data", value: payload },
    }),
  ];
}

function messageNotification(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const text = string(payload.message) ?? string(payload.text);
  if (text === null) return [];
  const reasoning = payload.type === "agent_reasoning";
  const user = payload.type === "user_message";
  const titles: Readonly<Record<string, string>> = {
    agent_reasoning: "Recorded reasoning",
    user_message: "User message notification",
    agent_message: "Assistant message notification",
  };
  return [
    event(record, {
      kind: reasoning ? "reasoning" : "message",
      role: user ? "user" : "assistant",
      title: titles[String(payload.type)] ?? "Message notification",
      preview: text,
      template: reasoning ? "reasoning" : "message",
      pointer: payload.message !== undefined ? "/payload/message" : "/payload/text",
      body: { type: "text", text, format: "markdown" },
    }),
  ];
}

const notificationReaders: Readonly<Record<string, RecordReader>> = {
  item_completed: (record, payload) => {
    const item = completedItem(record, payload);
    return item ? [item] : [];
  },
  mcp_tool_call_end: (record, payload) => {
    const item = mcpResult(record, payload, "/payload", payload.result ?? payload);
    return item ? [item] : [];
  },
  web_search_end: nativeSearchResult,
  sub_agent_activity: agentActivity,
  token_count: tokenCount,
  task_started: turnNotification,
  task_complete: turnNotification,
  turn_aborted: turnNotification,
  user_message: messageNotification,
  agent_message: messageNotification,
  agent_reasoning: messageNotification,
};

function notificationEvents(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const type = string(payload.type) ?? "unknown";
  const events = notificationReaders[type]?.(record, payload) ?? [];
  return events.length ? events : [diagnostic(record, `Unrecognized Codex event: ${type}`)];
}

function turnContext(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const policy = object(payload.sandbox_policy);
  const facts: TraceEvidence[] = [];
  if (payload.sandbox_policy !== undefined)
    facts.push(
      fact(
        "sandbox",
        policy.type === "danger-full-access" ? "bypass_enabled" : "available",
        policy.type === "danger-full-access"
          ? "Full-access sandbox policy recorded"
          : "Recorded sandbox policy",
        "/payload/sandbox_policy",
      ),
    );
  if (payload.approval_policy !== undefined)
    facts.push(
      fact(
        "sandbox",
        "available",
        `Approval policy: ${json(payload.approval_policy)}`,
        "/payload/approval_policy",
      ),
    );
  return [
    event(record, {
      kind: "context",
      title: "Turn context",
      preview: string(payload.model) ?? "Recorded turn configuration",
      pointer: "/payload",
      template: "context",
      evidence: facts,
      body: {
        type: "context",
        name: "Turn context",
        content: json(payload),
        format: "json",
        captured: true,
      },
    }),
  ];
}

function tokenUsage(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const events = (
    [
      ["usage", "response"],
      ["turn_token_usage", "turn"],
      ["thread_token_usage", "session"],
    ] as const
  )
    .map(([key, scope]) => usageEvent(record, payload[key], pointer("/payload", key), scope))
    .filter((item): item is ParsedEvent => item !== null);
  const responseId = string(payload.response_id);
  if (responseId)
    events.forEach((item) => {
      if (item.usage?.scope === "response") item.nativeId = responseId;
    });
  return events;
}

function metadataEvent(record: ObjectRecord, payload: ObjectRecord): ParsedEvent[] {
  const titles: Readonly<Record<string, string>> = {
    compacted: "Context compacted",
    world_state: "World state",
    inter_agent_communication_metadata: "Agent communication metadata",
  };
  return [
    event(record, {
      kind: "context",
      title: titles[String(record.type)] ?? "Context",
      preview: string(payload.message) ?? String(record.type),
      pointer: "/payload",
      template: "context",
      body: { type: "data", value: payload },
    }),
  ];
}

const recordReaders: Readonly<Record<string, RecordReader>> = {
  turn_context: turnContext,
  response_item: responseEvents,
  event_msg: notificationEvents,
  token_usage_record: tokenUsage,
  compacted: metadataEvent,
  world_state: metadataEvent,
  inter_agent_communication_metadata: metadataEvent,
};

function parse(value: unknown): ParsedRecord {
  const record = object(value);
  const payload = object(record.payload);
  if (record.type === "session_meta") return sessionEvents(record, payload);
  const session = sessionPatch(payload);
  const events = recordReaders[String(record.type)]?.(record, payload) ?? [];
  if (!events.length)
    events.push(
      diagnostic(value, `Unrecognized Codex record: ${string(record.type) ?? "unknown"}`),
    );
  const userContent =
    record.type === "response_item" && payload.type === "message" && payload.role === "user"
      ? payload.content
      : record.type === "event_msg" && payload.type === "user_message"
        ? (payload.message ?? payload.text)
        : null;
  const title = userPromptTitle(userContent);
  if (title) session.title = title;
  return { session, events };
}

export const codexAdapter: TraceAdapter = {
  id: "codex",
  label: "Codex",
  version: 3,
  roots: (home, env) => [
    rootPath(home, env.CODEX_HOME?.trim() || `${home}/.codex`, "sessions"),
    rootPath(home, env.CODEX_HOME?.trim() || `${home}/.codex`, "archived_sessions"),
  ],
  accepts: (path) => path.toLowerCase().endsWith(".jsonl"),
  parse,
};
