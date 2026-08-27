// Pure translation from parsed Amp bridge events (src/bridge/events.ts) to
// ACP session/update notifications. Ported from the upstream ACP reference
// adapter and trimmed for bb: user text is dropped (bb treats
// user_message_chunk as noise) and only update kinds bb renders are emitted.
import type {
  ContentBlock,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { oracleDirective } from "./oracle-directive.ts";
import type { OracleReportStore } from "./oracle-report-store.ts";
import {
  parseAmpImageBlock,
  type AmpEvent,
  type AmpImageContent,
  type AmpToolOutput,
} from "./bridge/events.ts";

export interface TranslationState {
  toolNamesById: Map<string, string>;
  oracleReportByToolId: Map<string, string>;
  oracleRootToolIds: Set<string>;
  oracleReports: OracleReportStore;
}

export function toSessionUpdates(
  event: AmpEvent,
  sessionId: string,
  state: TranslationState,
): SessionNotification[] {
  switch (event.kind) {
    case "text": {
      const parentReportId = parentReport(event.parent, state);
      if (parentReportId) {
        state.oracleReports.append(parentReportId, {
          kind: "message",
          title: "Oracle",
          content: event.text,
        });
      }
      return [chunk(sessionId, event.text)];
    }
    case "thinking": {
      const parentReportId = parentReport(event.parent, state);
      if (parentReportId) {
        state.oracleReports.append(parentReportId, {
          kind: "thinking",
          title: "Thinking",
          content: event.text,
        });
      }
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.text } as ContentBlock,
          },
        },
      ];
    }
    case "image":
      return [chunk(sessionId, ampImageToAcp(event.image))];
    case "toolStart": {
      const output: SessionNotification[] = [];
      const parentReportId = parentReport(event.parent, state);
      state.toolNamesById.set(event.callId, event.tool);
      const metadata = toolCallMetadata(event.tool, event.input);
      if (parentReportId) {
        state.oracleReportByToolId.set(event.callId, parentReportId);
        state.oracleReports.append(parentReportId, {
          kind: "tool",
          toolCallId: event.callId,
          title: metadata.title,
          status: "running",
        });
      }
      output.push({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.callId,
          status: "pending",
          title: metadata.title,
          kind: metadata.kind,
          locations: metadata.locations.length > 0 ? metadata.locations : undefined,
          rawInput: safeJson(event.input),
          content: [],
        },
      });
      if (event.tool.toLowerCase() === "oracle") {
        const reportId = state.oracleReports.start(event.input);
        const directive = reportId === null ? null : oracleDirective(reportId);
        if (reportId !== null) {
          state.oracleReportByToolId.set(event.callId, reportId);
          state.oracleRootToolIds.add(event.callId);
        }
        if (directive) output.push(chunk(sessionId, `\n\n${directive}\n\n`));
      }
      return output;
    }
    case "toolEnd": {
      const toolName = state.toolNamesById.get(event.callId);
      const reportId =
        state.oracleReportByToolId.get(event.callId) ?? parentReport(event.parent, state);
      const oracleRoot = state.oracleRootToolIds.has(event.callId);
      state.toolNamesById.delete(event.callId);
      state.oracleReportByToolId.delete(event.callId);
      const output: SessionNotification[] = [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.callId,
            status: event.failed ? "failed" : "completed",
            content: toToolContent(event.output, event.failed),
          },
        },
      ];
      if (reportId && oracleRoot) {
        state.oracleRootToolIds.delete(event.callId);
        state.oracleReports.complete(
          reportId,
          event.output.structured ?? event.output.text,
          event.failed,
        );
      } else if (reportId) {
        state.oracleReports.append(reportId, {
          kind: "tool",
          toolCallId: event.callId,
          title: toolName ?? "Tool",
          status: event.failed ? "error" : "completed",
        });
      }
      return output;
    }
    default:
      // init / userEcho / assistantStop / usage / resultOk / resultError /
      // raw carry no renderable content; the bridge core handles them.
      return [];
  }
}

export function finishOpenOracleReports(state: TranslationState, reason: string): void {
  const reportIds = new Set(
    [...state.oracleRootToolIds]
      .map((toolId) => state.oracleReportByToolId.get(toolId))
      .filter((reportId): reportId is string => reportId !== undefined),
  );
  for (const reportId of reportIds) state.oracleReports.complete(reportId, reason, true);
  state.oracleRootToolIds.clear();
  state.oracleReportByToolId.clear();
}

function parentReport(parent: string | null, state: TranslationState): string | undefined {
  return parent === null ? undefined : state.oracleReportByToolId.get(parent);
}

function chunk(sessionId: string, content: ContentBlock | string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: typeof content === "string" ? { type: "text", text: content } : content,
    },
  };
}

function toToolContent(output: AmpToolOutput, isError: boolean): ToolCallContent[] {
  if (Array.isArray(output.structured)) {
    const entries: ToolCallContent[] = [];
    for (const entry of output.structured) {
      if (!isRecord(entry)) continue;
      if (entry.type === "text" && typeof entry.text === "string") {
        entries.push({
          type: "content",
          content: { type: "text", text: isError ? wrapCode(entry.text) : entry.text },
        });
        continue;
      }
      if (entry.type === "image") {
        const image = parseAmpImageBlock(entry);
        if (image !== null) entries.push({ type: "content", content: ampImageToAcp(image) });
      }
    }
    return entries;
  }
  if (output.structured === null && output.text.length > 0) {
    return [
      {
        type: "content" as const,
        content: {
          type: "text" as const,
          text: isError ? wrapCode(output.text) : output.text,
        },
      },
    ];
  }
  return [];
}

/** ACP image content requires base64 bytes. URL-only images become links
 * instead of an invalid empty image payload. */
function ampImageToAcp(image: AmpImageContent): ContentBlock {
  return "base64" in image
    ? { type: "image", data: image.base64, mimeType: image.mimeType }
    : { type: "resource_link", uri: image.url, name: "Image" };
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
