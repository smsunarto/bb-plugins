// Pure translation from @ampcode/sdk stream-json messages to ACP
// session/update notifications. Ported from the upstream ACP reference
// adapter and trimmed for bb: user text chunks are dropped (bb treats user_message_chunk
// as noise) and only update kinds bb renders are emitted.
import type {
  ContentBlock,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";

/** One NDJSON line from `amp --execute --stream-json`, parsed. Kept loose:
 * the SDK yields output unvalidated and real streams carry blocks (thinking,
 * system errors) that its TypeScript types omit. */
export interface AmpStreamMessage {
  type: string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  result?: string;
  permission_denials?: string[];
  message?: { content?: unknown };
  [key: string]: unknown;
}

interface AmpTextBlock {
  type: "text";
  text: string;
}

interface AmpToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AmpTextBlock[];
  is_error: boolean;
}

export function toSessionUpdates(
  message: AmpStreamMessage,
  sessionId: string,
): SessionNotification[] {
  const assistant = message.type === "assistant";
  const content = message.message?.content;

  if (assistant && typeof content === "string") {
    return content.length > 0 ? [chunk(sessionId, content)] : [];
  }
  if (!Array.isArray(content)) return [];

  const output: SessionNotification[] = [];
  for (const block of content as Record<string, unknown>[]) {
    switch (block.type) {
      case "text":
        if (assistant && typeof block.text === "string" && block.text.length > 0) {
          output.push(chunk(sessionId, block.text));
        }
        break;
      case "thinking":
        if (assistant && typeof block.thinking === "string" && block.thinking.length > 0) {
          output.push({
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: block.thinking } as ContentBlock,
            },
          });
        }
        break;
      case "tool_use":
        if (assistant && typeof block.id === "string") {
          const name = typeof block.name === "string" ? block.name : "Tool";
          const metadata = toolCallMetadata(name, block.input);
          output.push({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: block.id,
              status: "pending",
              title: metadata.title,
              kind: metadata.kind,
              locations: metadata.locations.length > 0 ? metadata.locations : undefined,
              rawInput: safeJson(block.input),
              content: [],
            },
          });
        }
        break;
      case "tool_result":
        if (!assistant && typeof block.tool_use_id === "string") {
          const result = block as unknown as AmpToolResultBlock;
          output.push({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: result.tool_use_id,
              status: result.is_error ? "failed" : "completed",
              content: toToolContent(result.content, result.is_error),
            },
          });
        }
        break;
      default:
        break;
    }
  }
  return output;
}

function chunk(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text } as ContentBlock,
    },
  };
}

function toToolContent(content: string | AmpTextBlock[], isError: boolean): ToolCallContent[] {
  if (Array.isArray(content) && content.length > 0) {
    return content
      .filter((entry) => typeof entry?.text === "string")
      .map((entry) => ({
        type: "content" as const,
        content: { type: "text" as const, text: isError ? wrapCode(entry.text) : entry.text },
      }));
  }
  if (typeof content === "string" && content.length > 0) {
    return [{
      type: "content" as const,
      content: { type: "text" as const, text: isError ? wrapCode(content) : content },
    }];
  }
  return [];
}

function wrapCode(text: string): string {
  return "```\n" + text + "\n```";
}

interface ToolCallMetadata {
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
}

function toolCallMetadata(name: string, input: unknown): ToolCallMetadata {
  const args = isRecord(input) ? input : {};
  return {
    title: toolCallTitle(name, args),
    kind: toolKind(name),
    locations: toolCallLocations(args),
  };
}

const PATH_KEYS = ["path", "file_path", "notebook_path"];

function toolCallTitle(name: string, input: Record<string, unknown>): string {
  const path = firstString(input, PATH_KEYS);
  switch (name) {
    case "Bash":
      return withDetail(name, commandValue(input));
    case "Read":
    case "read_file":
    case "Write":
    case "create_file":
    case "Edit":
    case "edit_file":
    case "MultiEdit":
    case "undo_edit":
      return withDetail(name, path);
    case "Glob":
    case "glob":
    case "Grep":
      return withDetail(name, stringValue(input.pattern) ?? stringValue(input.filePattern) ?? path);
    case "LS":
    case "list_directory":
      return withDetail("List", path);
    case "WebFetch":
    case "read_web_page":
      return withDetail(name, stringValue(input.url));
    case "web_search":
      return withDetail("Web search", stringValue(input.query));
    case "TodoWrite":
    case "todo_write":
      return "Update todo list";
    case "Task":
      return withDetail(name, stringValue(input.description) ?? stringValue(input.subagent_type));
    default:
      return withDetail(name, firstScalarString(input));
  }
}

function commandValue(input: Record<string, unknown>): string | undefined {
  return (
    commandSegmentValue(input.cmd) ??
    commandSegmentValue(input.command) ??
    firstString(input, ["shell_command", "shellCommand", "script"])
  );
}

function commandSegmentValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function toolKind(name: string): ToolKind {
  switch (name) {
    case "Read":
    case "read_file":
    case "LS":
    case "list_directory":
      return "read";
    case "Write":
    case "create_file":
    case "Edit":
    case "edit_file":
    case "MultiEdit":
    case "undo_edit":
      return "edit";
    case "Glob":
    case "glob":
    case "Grep":
    case "codebase_search_agent":
      return "search";
    case "Bash":
      return "execute";
    case "WebFetch":
    case "read_web_page":
    case "web_search":
      return "fetch";
    case "TodoWrite":
    case "todo_write":
    case "Task":
    case "oracle":
      return "think";
    default:
      return name.startsWith("mcp__") ? "fetch" : "other";
  }
}

function toolCallLocations(input: Record<string, unknown>): ToolCallLocation[] {
  const path = firstString(input, PATH_KEYS);
  if (!path) return [];
  const line = numberValue(input.line) ?? numberValue(input.offset);
  return line === undefined ? [{ path }] : [{ path, line }];
}

function withDetail(name: string, detail: string | undefined): string {
  if (!detail) return name;
  return `${name}: ${truncateSingleLine(detail, 120)}`;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

function firstScalarString(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
