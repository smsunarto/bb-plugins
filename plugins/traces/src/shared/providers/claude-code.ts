import type { ParsedEvent, ParsedRecord, TraceAdapter, TraceEvidence } from "../model";
import {
  baseSession,
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
  instructionTitles,
  string,
  textEvent,
  timestamp,
  type ObjectRecord,
} from "./common";
import { toolCall, toolEvidence, toolResult } from "./tools";
import { userPromptTitle } from "./title";

function namedEvidence(
  value: unknown,
  at: string,
  topic: TraceEvidence["topic"],
  action: TraceEvidence["action"],
): TraceEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((item, index) => {
    const name = string(item) ?? string(object(item).name);
    return name
      ? [
          fact(
            topic,
            action,
            name,
            typeof item === "string" ? pointer(at, index) : pointer(pointer(at, index), "name"),
          ),
        ]
      : [];
  });
}

function attachmentEvent(
  record: ObjectRecord,
  attachment: ObjectRecord,
  fields: Partial<ParsedEvent>,
): ParsedEvent {
  const title = (string(attachment.type) ?? "unknown").replaceAll("_", " ");
  const content = string(attachment.content);
  return event(record, {
    kind: "context",
    title,
    preview: content ?? json(attachment),
    template: "context",
    pointer: "/attachment",
    body:
      content === null
        ? { type: "data", value: attachment }
        : { type: "context", name: title, content, format: "markdown", captured: true },
    ...fields,
  });
}

function invokedSkills(record: ObjectRecord, attachment: ObjectRecord): ParsedEvent[] {
  if (!Array.isArray(attachment.skills)) return [];
  const items = attachment.skills.slice(0, MAX_PARTS).flatMap((value, index) => {
    const skill = object(value);
    const name = string(skill.name);
    if (!name) return [];
    const at = pointer("/attachment/skills", index);
    const text = string(skill.content);
    return [
      event(record, {
        kind: "context",
        title: name,
        preview: text ?? string(skill.path) ?? name,
        template: "skill",
        pointer: at,
        evidence: [fact("skills", "invoked", name, `${at}/name`)],
        body:
          text === null
            ? { type: "data", value: skill }
            : {
                type: "context",
                name: string(skill.path) ?? name,
                content: text,
                format: "markdown",
                captured: true,
              },
      }),
    ];
  });
  return [...items, ...overflowParts(record, attachment.skills, "/attachment/skills")];
}

function deferredTools(record: ObjectRecord, attachment: ObjectRecord): ParsedEvent[] {
  const facts: TraceEvidence[] = [];
  if (Array.isArray(attachment.addedNames)) {
    attachment.addedNames.slice(0, 64).forEach((value, index) => {
      if (typeof value !== "string") return;
      const nameAt = pointer("/attachment/addedNames", index);
      facts.push(
        ...toolEvidence(
          value,
          {},
          { at: "/attachment", inputAt: "/attachment", nameAt, action: "available" },
        ).facts,
      );
    });
  }
  // The action carries whether the server came up, so the inspector can badge a
  // server group as available, pending, or unavailable without parsing labels.
  const states = [
    ["pendingMcpServers", "pending", "requested"],
    ["needsAuthMcpServers", "authentication required", "requested"],
    ["failedMcpServers", "failed", "blocked"],
  ] as const;
  for (const [key, state, action] of states) {
    for (const item of namedEvidence(attachment[key], pointer("/attachment", key), "mcp", action)) {
      item.label = `${item.label} (${state})`;
      facts.push(item);
    }
  }
  return [attachmentEvent(record, attachment, { title: "Available tools", evidence: facts })];
}

function mcpInstructions(record: ObjectRecord, attachment: ObjectRecord): ParsedEvent[] {
  const facts = namedEvidence(attachment.addedNames, "/attachment/addedNames", "mcp", "available");
  const blocks = Array.isArray(attachment.addedBlocks) ? attachment.addedBlocks : [];
  const text = blocks.filter((item): item is string => typeof item === "string").join("\n\n");
  if (!text)
    return [attachmentEvent(record, attachment, { title: "MCP instructions", evidence: facts })];
  facts.push(
    fact("instructions", "loaded", "Recorded MCP instructions", "/attachment/addedBlocks"),
  );
  return [
    attachmentEvent(record, attachment, {
      title: "MCP instructions",
      template: "instructions",
      evidence: facts,
      body: {
        type: "context",
        name: "MCP instructions",
        content: text,
        format: "markdown",
        captured: true,
      },
    }),
  ];
}

function fileAttachment(record: ObjectRecord, attachment: ObjectRecord): ParsedEvent[] {
  const filename = string(attachment.filename) ?? string(attachment.displayPath) ?? "Recorded file";
  const name = filename.split(/[\\/]/).at(-1);
  const topics: Readonly<Record<string, "skills" | "instructions">> = {
    "SKILL.md": "skills",
    "AGENTS.md": "instructions",
    "CLAUDE.md": "instructions",
  };
  const topic = topics[name ?? ""];
  const content = string(attachment.content);
  const at =
    content !== null
      ? "/attachment/content"
      : attachment.filename !== undefined
        ? "/attachment/filename"
        : "/attachment/displayPath";
  const facts = topic ? [fact(topic, content === null ? "reference" : "loaded", filename, at)] : [];
  const template = topic === "skills" ? "skill" : (topic ?? "context");
  return [
    attachmentEvent(record, attachment, {
      title: filename,
      template,
      evidence: facts,
      body: {
        type: "context",
        name: filename,
        content: content ?? "",
        format: "markdown",
        captured: content !== null,
      },
    }),
  ];
}

// Memory files arrive as a list of records, not as the assembled prose the model
// reads. Rebuilding that prose gives the inspector one instruction event it can
// split back into a section per file, and names the files as evidence.
function memoryInstructions(record: ObjectRecord, attachment: ObjectRecord): ParsedEvent[] {
  const files = Array.isArray(attachment.files) ? attachment.files.slice(0, MAX_PARTS) : [];
  const facts: TraceEvidence[] = [];
  const blocks: string[] = [];
  files.forEach((value, index) => {
    const file = object(value);
    const path = string(file.path);
    if (!path) return;
    const at = pointer(pointer("/attachment/files", index), "path");
    facts.push(fact("instructions", "loaded", path, at));
    blocks.push(
      `Contents of ${path} (${string(file.type) ?? "instructions"}):\n\n${string(file.content) ?? ""}`,
    );
  });
  if (!blocks.length)
    return [attachmentEvent(record, attachment, { title: instructionTitles.memory })];
  return [
    attachmentEvent(record, attachment, {
      title: instructionTitles.memory,
      template: "instructions",
      preview: facts.map((item) => item.label).join(" · "),
      evidence: facts,
      body: {
        type: "context",
        name: instructionTitles.memory,
        content: blocks.join("\n\n"),
        format: "markdown",
        captured: true,
      },
    }),
  ];
}

function sandboxInstructions(record: ObjectRecord, attachment: ObjectRecord): ParsedEvent[] {
  const facts = [fact("sandbox", "available", "Recorded sandbox policy", "/attachment")];
  if (typeof attachment.content === "string")
    facts.push(
      fact("instructions", "loaded", "Recorded sandbox instructions", "/attachment/content"),
    );
  return [
    attachmentEvent(record, attachment, {
      title: "Sandbox instructions",
      template: "instructions",
      evidence: facts,
    }),
  ];
}

const attachmentReaders: Readonly<
  Record<string, (record: ObjectRecord, attachment: ObjectRecord) => ParsedEvent[]>
> = {
  invoked_skills: invokedSkills,
  deferred_tools_delta: deferredTools,
  mcp_instructions_delta: mcpInstructions,
  file: fileAttachment,
  compact_file_reference: fileAttachment,
  sandbox_instructions: sandboxInstructions,
  instructions: memoryInstructions,
  skill_listing: (record, attachment) => {
    const facts = namedEvidence(attachment.names, "/attachment/names", "skills", "available");
    if (!facts.length) facts.push(fact("skills", "available", "Skill catalog", "/attachment"));
    return [attachmentEvent(record, attachment, { title: "Available skills", evidence: facts })];
  },
  agent_listing_delta: (record, attachment) => [
    attachmentEvent(record, attachment, {
      title: "Available agents",
      evidence: namedEvidence(
        attachment.addedTypes,
        "/attachment/addedTypes",
        "subagents",
        "available",
      ),
    }),
  ],
  auto_mode: (record, attachment) => [
    attachmentEvent(record, attachment, {
      title: "Permission mode",
      evidence: [
        fact(
          "sandbox",
          attachment.bypass === true ? "bypass_enabled" : "available",
          attachment.bypass === true ? "Sandbox bypass enabled" : "Recorded auto-mode policy",
          "bypass" in attachment ? "/attachment/bypass" : "/attachment",
        ),
      ],
    }),
  ],
};

function attachmentEvents(record: ObjectRecord): ParsedEvent[] {
  const attachment = object(record.attachment);
  const events = attachmentReaders[String(attachment.type)]?.(record, attachment) ?? [];
  return events.length ? events : [attachmentEvent(record, attachment, {})];
}

function usageEvent(record: ObjectRecord, value: unknown, at: string): ParsedEvent | null {
  const usage = object(value);
  const input = finite(usage.input_tokens);
  const output = finite(usage.output_tokens);
  const cached = finite(usage.cache_read_input_tokens);
  if (input === null && output === null && cached === null) return null;
  return event(record, {
    kind: "usage",
    title: "Response usage",
    preview: json(usage),
    template: "usage",
    pointer: at,
    nativeId: string(object(record.message).id) ?? string(record.uuid),
    usage: { input, output, cached, scope: "response" },
    body: { type: "data", value: usage },
  });
}

function messageEvents(record: ObjectRecord): ParsedEvent[] {
  const message = object(record.message);
  const role = message.role === "assistant" || record.type === "assistant" ? "assistant" : "user";
  const events: ParsedEvent[] = [];
  if (typeof message.content === "string")
    events.push(textEvent(record, message.content, role, "/message/content"));
  if (Array.isArray(message.content)) {
    message.content.slice(0, MAX_PARTS).forEach((value, index) => {
      const block = object(value);
      const at = pointer("/message/content", index);
      if (block.type === "text" && typeof block.text === "string") {
        events.push(textEvent(record, block.text, role, `${at}/text`));
      } else if (block.type === "thinking") {
        events.push(
          event(record, {
            kind: "reasoning",
            role: "assistant",
            title: "Recorded reasoning",
            preview: string(block.thinking) ?? "No readable reasoning recorded",
            template: "reasoning",
            pointer: at,
            body:
              typeof block.thinking === "string"
                ? { type: "text", text: block.thinking, format: "markdown" }
                : { type: "data", value: block },
          }),
        );
      } else if (block.type === "redacted_thinking") {
        events.push(
          event(record, {
            kind: "reasoning",
            role: "assistant",
            title: "Redacted reasoning",
            template: "reasoning",
            pointer: at,
            preview: "The trace contains redacted reasoning.",
            body: { type: "data", value: block },
          }),
        );
      } else if (
        (block.type === "tool_use" || block.type === "server_tool_use") &&
        string(block.name)
      ) {
        events.push(
          toolCall(record, {
            name: String(block.name),
            callId: string(block.id),
            value: block.input,
            at,
            inputAt: `${at}/input`,
            nameAt: `${at}/name`,
          }),
        );
      } else if (
        block.type === "tool_result" ||
        block.type === "web_search_tool_result" ||
        block.type === "web_fetch_tool_result"
      ) {
        events.push(
          toolResult(record, {
            value: block.content,
            callId: string(block.tool_use_id),
            at,
            outputAt: `${at}/content`,
            ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
          }),
        );
      } else {
        events.push(
          event(record, {
            title: `Recorded ${string(block.type) ?? "content"}`,
            preview: string(block.type) ?? "Unrecognized content block",
            pointer: at,
            body: { type: "data", value },
          }),
        );
      }
    });
    events.push(...overflowParts(record, message.content, "/message/content"));
  }
  const usage = usageEvent(record, message.usage, "/message/usage");
  if (usage) events.push(usage);
  if (!events.length) events.push(diagnostic(record, "Unrecognized message content"));
  if (record.permissionMode === "bypassPermissions") {
    const first = events[0]!;
    events[0] = event(record, {
      ...first,
      evidence: [
        ...first.evidence,
        fact("sandbox", "bypass_enabled", "Bypass permissions mode recorded", "/permissionMode"),
      ],
    });
  }
  const attributed = messageAttribution(record);
  if (attributed.length) {
    const first = events[0]!;
    events[0] = event(record, { ...first, evidence: [...first.evidence, ...attributed] });
  }
  return events;
}

function messageAttribution(record: ObjectRecord): TraceEvidence[] {
  const facts: TraceEvidence[] = [];
  if (record.type === "assistant") {
    for (const [key, topic] of [
      ["attributionSkill", "skills"],
      ["attributionPlugin", "plugins"],
      ["attributionAgent", "subagents"],
    ] as const) {
      const name = string(record[key]);
      if (name)
        facts.push(
          fact(topic, topic === "subagents" ? "result" : "invoked", name, pointer("", key)),
        );
    }
  }
  const toolUseResult = object(record.toolUseResult);
  const agentId = string(toolUseResult.agentId);
  if (agentId)
    facts.push(fact("subagents", "result", `Agent ${agentId}`, "/toolUseResult/agentId"));
  if (toolUseResult.dangerouslyDisableSandbox === true)
    facts.push(
      fact(
        "sandbox",
        "bypass_requested",
        "Sandbox bypass flag recorded in tool result",
        "/toolUseResult/dangerouslyDisableSandbox",
      ),
    );
  return facts;
}

function titleEvents(record: ObjectRecord): ParsedEvent[] {
  const title = string(record.customTitle);
  return title
    ? [
        event(record, {
          kind: "context",
          title: "Session title",
          preview: title,
          pointer: "/customTitle",
          template: "context",
          body: { type: "text", text: title, format: "plain" },
        }),
      ]
    : [];
}

function initializationEvents(record: ObjectRecord): ParsedEvent[] {
  const facts = [
    ...namedEvidence(record.plugins, "/plugins", "plugins", "available"),
    ...namedEvidence(record.mcp_servers, "/mcp_servers", "mcp", "available"),
  ];
  if (string(record.permissionMode))
    facts.push(
      fact(
        "sandbox",
        record.permissionMode === "bypassPermissions" ? "bypass_enabled" : "available",
        `Permission mode: ${String(record.permissionMode)}`,
        "/permissionMode",
      ),
    );
  return [
    event(record, {
      kind: "context",
      title: "Session configuration",
      template: "context",
      preview: string(record.model) ?? "Recorded initialization",
      evidence: facts,
    }),
  ];
}

function turnEvents(record: ObjectRecord): ParsedEvent[] {
  const result = event(record, {
    kind: "turn",
    title: record.is_error === true ? "Turn failed" : "Turn completed",
    template: "turn",
    preview: string(record.result) ?? json(record),
    body: { type: "data", value: record },
  });
  const usage = usageEvent(record, record.usage, "/usage");
  return usage ? [result, usage] : [result];
}

function contextEvents(record: ObjectRecord): ParsedEvent[] {
  const text = contentText(record.content) || string(record.summary) || "";
  return [
    event(record, {
      kind: "context",
      title: string(record.subtype) ?? string(record.type) ?? "Context",
      template: "context",
      preview: text || json(record),
      evidence:
        record.mode === "bypassPermissions"
          ? [fact("sandbox", "bypass_enabled", "Bypass permissions mode recorded", "/mode")]
          : [],
      body: text
        ? {
            type: "context",
            name: string(record.subtype) ?? "Recorded context",
            content: text,
            format: "markdown",
            captured: true,
          }
        : { type: "data", value: record },
    }),
  ];
}

function systemEvents(record: ObjectRecord): ParsedEvent[] {
  if (record.subtype === "init") return initializationEvents(record);
  if (record.subtype === "turn_duration") return turnEvents(record);
  return contextEvents(record);
}

const recordReaders: Readonly<Record<string, (record: ObjectRecord) => ParsedEvent[]>> = {
  user: messageEvents,
  assistant: messageEvents,
  attachment: attachmentEvents,
  "custom-title": titleEvents,
  system: systemEvents,
  result: turnEvents,
  summary: contextEvents,
  mode: contextEvents,
};

function parse(value: unknown): ParsedRecord {
  const record = object(value);
  const session = baseSession(record);
  const events = recordReaders[String(record.type)]?.(record) ?? [];
  // The record type is the only useful name for a record no reader claims. Saying
  // it is unrecognized only repeats the "diagnostic" kind already on the event.
  if (!events.length) events.push(diagnostic(value, string(record.type) ?? "Recorded record"));
  const title =
    record.type === "custom-title"
      ? string(record.customTitle)
      : record.type === "user"
        ? userPromptTitle(object(record.message).content)
        : null;
  if (title) session.title = title.slice(0, 160);
  if (record.type === "system" && record.subtype === "init") {
    const startedAt = timestamp(record.timestamp);
    if (startedAt !== null) session.startedAt = startedAt;
  }
  return { session, events };
}

export const claudeCodeAdapter: TraceAdapter = {
  id: "claude-code",
  label: "Claude Code",
  version: 4,
  roots: (home, env) => [
    rootPath(home, env.CLAUDE_CONFIG_DIR?.trim() || `${home}/.claude`, "projects"),
  ],
  accepts: (path) => path.toLowerCase().endsWith(".jsonl"),
  parse,
};
