/**
 * `src/bridge/shapes.ts` — Amp tool name + input → a `TimelineRow`.
 *
 * Pure and total. Today `translate.ts` produces `{ title, kind }` where
 * `kind` is one of ACP's seven buckets; grammar v3 has real shapes: `fileRead`
 * renders a file row with the path, `search` renders a query row, `command`
 * renders a terminal with an exit code, `planSteps` renders a plan. The
 * mapping is a table, so it lives alone with no dependency on anything but
 * the SDK's presentation helpers.
 */

import {
  experimental_fileReadPresentation as fileReadPresentation,
  experimental_planStepsPresentation as planStepsPresentation,
  experimental_presentationFileName as presentationFileName,
  experimental_presentationTitle as presentationTitle,
  experimental_searchPresentation as searchPresentation,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
  experimental_withTitle as withTitle,
  type DeltaPresentation,
  type JsonValue,
  type ThreadEventItemStatus,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AmpImageContent } from "./events.ts";
import type { TimelineRow } from "./timeline.ts";

/** Namespaced extension kinds this bridge may emit. Must match the plugin
 *  declaration's `extensionKinds` keys — the server validates payloads against
 *  those schemas and persists `provider/unhandled` on a miss. */
export const AMP_ORACLE_KIND = "amp/oracle";
export const AMP_THREAD_LINK_KIND = "amp/thread-link";

/** The Oracle receipt payload. Small on purpose: the report body lives in the
 *  XDG file store and the plugin's `getOracleReport` RPC serves it. The
 *  timeline item carries only what a row needs to render. */
export interface OracleReceipt extends Record<string, JsonValue> {
  reportId: string;
  question: string;
}

const PATH_KEYS = ["path", "file_path", "notebook_path"];

/**
 * Describe one Amp tool call.
 *
 * Args object rather than positionals (deviation from the sketch): the
 * `delegation` shape needs `callId` for its deterministic `childRef`, and the
 * `command` shape requires a `cwd` string in grammar v3.
 */
export function describeAmpTool(args: {
  tool: string;
  input: JsonValue;
  callId: string;
  /** Fallback working directory for `command` rows (`cwd` is required). */
  cwd: string;
  /** Amp tool names that are bb dynamic tools proxied through MCP; those rows
   *  get `server: "bb"` so the user sees their own tool. */
  bbToolIds: ReadonlySet<string>;
}): TimelineRow {
  const { tool, callId, cwd } = args;
  const inputRecord = jsonRecord(args.input);
  const input = inputRecord ?? {};
  const path = firstString(input, PATH_KEYS);
  switch (tool) {
    case "Read":
    case "read_file":
      if (path === undefined) break;
      return { item: { type: "fileRead", path }, presentation: fileReadPresentation(path) };
    case "Write":
    case "create_file": {
      if (path === undefined) break;
      const newText = stringValue(input.content);
      return {
        item: {
          type: "fileChange",
          changes: [{ path, kind: "add", ...(newText === undefined ? {} : { newText }) }],
        },
        presentation: fileChangePresentation("add", path),
      };
    }
    case "Edit":
    case "edit_file":
    case "MultiEdit":
    case "undo_edit": {
      if (path === undefined) break;
      const oldText = stringValue(input.old_str);
      const newText = stringValue(input.new_str);
      return {
        item: {
          type: "fileChange",
          changes: [
            {
              path,
              kind: "update",
              ...(oldText === undefined ? {} : { oldText }),
              ...(newText === undefined ? {} : { newText }),
            },
          ],
        },
        presentation: fileChangePresentation("update", path),
      };
    }
    case "Grep":
    case "grep":
    case "codebase_search_agent": {
      const query =
        stringValue(input.pattern) ??
        stringValue(input.query) ??
        stringValue(input.filePattern) ??
        "";
      return {
        item: { type: "search", mode: "content", query, ...(path === undefined ? {} : { path }) },
        presentation: searchPresentation({ mode: "content", query }),
      };
    }
    case "Glob":
    case "glob": {
      const query = stringValue(input.pattern) ?? stringValue(input.filePattern) ?? path ?? "";
      return {
        item: { type: "search", mode: "path", query },
        presentation: searchPresentation({ mode: "path", query }),
      };
    }
    case "LS":
    case "list_directory": {
      const query = path ?? ".";
      return {
        item: { type: "search", mode: "list", query },
        presentation: withTitle(
          {
            icon: { glyph: "FolderOpen" },
            label: { pending: "Listing files", completed: "Listed files" },
          },
          presentationTitle(query),
        ),
      };
    }
    case "Bash": {
      const command = commandValue(input) ?? "";
      return {
        item: { type: "command", command, cwd: stringValue(input.cwd) ?? cwd },
        presentation: withTitle(
          {
            icon: { glyph: "Terminal" },
            label: { pending: "Running command", completed: "Ran command" },
          },
          presentationTitle(command),
        ),
      };
    }
    case "web_search": {
      const query = stringValue(input.query);
      return {
        item: { type: "webSearch", queries: query === undefined ? [] : [query] },
        presentation: webSearchPresentation(query),
      };
    }
    case "WebFetch":
    case "read_web_page": {
      const url = stringValue(input.url);
      if (url === undefined) break;
      return {
        item: { type: "webFetch", url, pattern: null },
        presentation: webFetchPresentation(url),
      };
    }
    case "TodoWrite":
    case "todo_write": {
      const steps = todoSteps(input.todos);
      return { item: { type: "planSteps", steps }, presentation: planStepsPresentation(steps) };
    }
    case "Task": {
      const label = stringValue(input.description) ?? stringValue(input.subagent_type) ?? tool;
      return {
        // childRef is the Amp tool-use id, never process entropy — the parity
        // oracle replays the recording and has to reproduce it.
        item: { type: "delegation", childRef: callId, label, background: false },
        presentation: withTitle(
          {
            icon: { glyph: "UserRound" },
            label: { pending: "Delegating", completed: "Delegated" },
          },
          presentationTitle(label),
        ),
      };
    }
    default:
      break;
  }
  const mcp = parseMcpName(tool);
  if (mcp !== null) {
    const server = args.bbToolIds.has(tool) || mcp.server === "bb-bridge" ? "bb" : mcp.server;
    return {
      item: {
        type: "tool",
        tool: mcp.name,
        server,
        ...(inputRecord === undefined ? {} : { args: inputRecord }),
      },
      presentation: toolPresentation(mcp.name),
    };
  }
  const detail = firstScalarString(input);
  const presentation = toolPresentation(tool);
  return {
    item: { type: "tool", tool, ...(inputRecord === undefined ? {} : { args: inputRecord }) },
    presentation:
      detail === undefined ? presentation : withTitle(presentation, presentationTitle(detail)),
  };
}

/** An inline image Amp produced. Grammar v3 has no image carrier with bytes
 *  or a URL (`imageView` is path-only), so the row is a `tool` shape whose
 *  result names the image — a rendering downgrade from the ACP path recorded
 *  as a U2 deviation. */
export function imageRow(image: AmpImageContent): TimelineRow {
  return {
    item: {
      type: "tool",
      tool: "image",
      result: "base64" in image ? { mimeType: image.mimeType } : { url: image.url },
    },
    presentation: {
      icon: { glyph: "FileText" },
      label: { pending: "Rendering image", completed: "Rendered image" },
    },
  };
}

/** The Oracle row: a real extension item, replacing the `::amp-oracle{…}`
 *  text directive the ACP bridge injects into assistant prose. The glyph must
 *  be a declared `bb.branding.experimental_icons` name. */
export function oracleRow(args: {
  reportId: string;
  question: string;
  onSettle: (status: ThreadEventItemStatus) => void;
}): TimelineRow {
  const payload: OracleReceipt = { reportId: args.reportId, question: args.question };
  return {
    item: { type: "extension", kind: AMP_ORACLE_KIND, payload },
    presentation: withTitle(
      {
        icon: { glyph: "amp/oracle" },
        label: { pending: "Consulting the Oracle", completed: "Oracle answered" },
      },
      presentationTitle(args.question),
    ),
    onSettle: args.onSettle,
  };
}

/** Merge an opened row with its result, producing the FULL terminal shape
 *  `item.close` requires. Split out so the completeness rule is one function
 *  with one test, not a spread at every close site. */
export function terminalRow(
  opened: TimelineRow,
  output: { text: string; structured: JsonValue | null; failed: boolean },
): TimelineRow {
  const item = opened.item;
  switch (item.type) {
    case "tool": {
      if (output.failed) {
        return {
          ...opened,
          item: { ...item, error: output.text.length > 0 ? output.text : "failed" },
        };
      }
      const result = output.structured ?? (output.text.length > 0 ? output.text : undefined);
      return result === undefined ? opened : { ...opened, item: { ...item, result } };
    }
    case "delegation": {
      const summary = truncateSingleLine(output.text, 200);
      return summary.length === 0 ? opened : { ...opened, item: { ...item, summary } };
    }
    case "search": {
      if (output.failed || output.text.length === 0) return opened;
      const count = output.text.split("\n").filter((line) => line.trim().length > 0).length;
      return {
        ...opened,
        presentation: {
          ...opened.presentation,
          detail: `${count} result${count === 1 ? "" : "s"}`,
        },
      };
    }
    default:
      // command output rides the generic close fields (aggregatedOutput,
      // exitCode); fileRead/webFetch/webSearch/planSteps/extension terminal
      // shapes equal their opened shapes.
      return opened;
  }
}

// ---------------------------------------------------------------------------
// Helpers (ported from translate.ts, which U5 deletes)
// ---------------------------------------------------------------------------

function fileChangePresentation(kind: "add" | "update", path: string): DeltaPresentation {
  return withTitle(
    {
      icon: { glyph: "EditFile" },
      label:
        kind === "add"
          ? { pending: "Creating file", completed: "Created file" }
          : { pending: "Editing file", completed: "Edited file" },
    },
    presentationTitle(presentationFileName(path)),
  );
}

function todoSteps(
  value: JsonValue | undefined,
): { step: string; status: "active" | "completed" | "failed" | "pending" }[] {
  if (!Array.isArray(value)) return [];
  const steps: { step: string; status: "active" | "completed" | "failed" | "pending" }[] = [];
  for (const entry of value) {
    const record = jsonRecord(entry);
    if (record === undefined) continue;
    const step =
      stringValue(record.content) ?? stringValue(record.text) ?? stringValue(record.title);
    if (step === undefined) continue;
    steps.push({ step, status: todoStatus(stringValue(record.status)) });
  }
  return steps;
}

function todoStatus(value: string | undefined): "active" | "completed" | "failed" | "pending" {
  switch (value) {
    case "in-progress":
    case "in_progress":
      return "active";
    case "completed":
    case "done":
      return "completed";
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return "pending";
  }
}

function parseMcpName(tool: string): { server: string; name: string } | null {
  if (!tool.startsWith("mcp__")) return null;
  const rest = tool.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) return null;
  return { server: rest.slice(0, separator), name: rest.slice(separator + 2) };
}

function commandValue(input: { [key: string]: JsonValue }): string | undefined {
  return (
    commandSegmentValue(input.cmd) ??
    commandSegmentValue(input.command) ??
    firstString(input, ["shell_command", "shellCommand", "script"])
  );
}

function commandSegmentValue(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function firstString(input: { [key: string]: JsonValue }, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstScalarString(input: { [key: string]: JsonValue }): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function jsonRecord(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
