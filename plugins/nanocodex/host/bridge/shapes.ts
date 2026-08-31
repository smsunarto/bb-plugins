/**
 * `host/bridge/shapes.ts` — nanocodex's tool vocabulary as timeline rows.
 *
 * A lookup table, imported only by `project.ts`. It owns one decision: what a
 * given nanocodex tool call LOOKS like in a bb thread. Keeping it out of the
 * translator keeps the translator about sequencing and this about rendering.
 */

import {
  experimental_planStepsPresentation as planStepsPresentation,
  experimental_presentationFileName as presentationFileName,
  experimental_presentationTitle as presentationTitle,
  experimental_toolPresentation as toolPresentation,
  experimental_withTitle as withTitle,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { TimelineRow } from "./timeline.ts";

/** Standard tools — crates/nanocodex-tools/src/standard.rs. */
export const STANDARD_TOOLS = [
  "exec_command",
  "write_stdin",
  "update_plan",
  "apply_patch",
  "view_image",
] as const;

/** Subagent tools — crates/nanocodex-subagents/src/tools.rs. Rendered as delegations. */
export const SUBAGENT_TOOLS = [
  "spawn_agent",
  "submit_result",
  "send_agent_message",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
  "close_agent",
] as const;

/**
 * The code-mode wrapper. In `orchestration: "local_code_mode"` nanocodex emits
 * one `tool.call {tool: "exec"}` whose `arguments` is a JavaScript program, and
 * then a `tool.call`/`tool.result` pair per `tools.*` call inside it, with
 * `call_id` = `${parentCallId}/code-${n}`. `exec` is not in the standard list.
 */
export const CODE_MODE_TOOL = "exec";

/** True for a `call_id` of the form `<parent>/code-<n>`. */
export function parseCodeModeChild(callId: string): { parentCallId: string; index: number } | null {
  // The greedy `.*` makes the parent id everything before the LAST such
  // suffix, so nesting deeper than one level still resolves.
  const match = /^(.*)\/code-(\d+)$/.exec(callId);
  if (match === null) return null;
  return { parentCallId: match[1]!, index: Number(match[2]!) };
}

/**
 * The row for an opening tool call.
 *
 *   exec_command -> command   {command: args.cmd, cwd: args.workdir}
 *   apply_patch  -> fileChange {changes: parseApplyPatch(args)}
 *   update_plan  -> planSteps
 *   view_image   -> imageView {path}
 *   spawn_agent  -> delegation {childRef: call_id, label, background: false}
 *   exec         -> tool      {tool: "code", args: {script}} with the script as
 *                             the detail — it is the wrapper, and its children
 *                             carry the real work
 *   anything else-> tool      via experimental_toolPresentation(tool)
 *
 * Unknown tool names are expected, not exceptional: MCP servers namespace their
 * tools and `--mcp-defaults` attaches five of them by default.
 *
 * `callId` is a deviation from the sketch's two-field signature: the
 * `delegation` shape needs a deterministic `childRef`, and the nanocodex
 * `call_id` is the only replay-stable value available.
 */
export function rowForToolCall(args: {
  tool: string;
  /** Object or raw string; the string case is code mode. */
  arguments: string | Record<string, unknown>;
  callId: string;
}): TimelineRow {
  const { tool, callId } = args;
  const input = typeof args.arguments === "string" ? {} : args.arguments;
  switch (tool) {
    case "exec_command": {
      const command = stringValue(input.cmd) ?? "";
      return {
        item: { type: "command", command, cwd: stringValue(input.workdir) ?? "" },
        presentation: withTitle(
          {
            icon: { glyph: "Terminal" },
            label: { pending: "Running command", completed: "Ran command" },
          },
          presentationTitle(command),
        ),
      };
    }
    case "apply_patch": {
      const patch =
        typeof args.arguments === "string"
          ? args.arguments
          : (stringValue(input.patch) ?? stringValue(input.input) ?? "");
      const changes = parseApplyPatch(patch);
      const firstPath = changes[0]?.path ?? "";
      return {
        item: { type: "fileChange", changes },
        presentation: withTitle(
          {
            icon: { glyph: "EditFile" },
            label: { pending: "Applying patch", completed: "Applied patch" },
          },
          presentationTitle(presentationFileName(firstPath)),
        ),
      };
    }
    case "update_plan": {
      const steps = planSteps(input.plan);
      return { item: { type: "planSteps", steps }, presentation: planStepsPresentation(steps) };
    }
    case "view_image": {
      const path = stringValue(input.path) ?? "";
      return {
        item: { type: "imageView", path },
        presentation: withTitle(
          {
            icon: { glyph: "FileText" },
            label: { pending: "Viewing image", completed: "Viewed image" },
          },
          presentationTitle(presentationFileName(path)),
        ),
      };
    }
    case "spawn_agent": {
      const label = truncateSingleLine(
        stringValue(input.message) ?? stringValue(input.prompt) ?? stringValue(input.task) ?? tool,
        120,
      );
      return {
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
    case CODE_MODE_TOOL: {
      const script = typeof args.arguments === "string" ? args.arguments : "";
      return {
        item: { type: "tool", tool: "code", args: { script } },
        presentation: withTitle(
          toolPresentation("code"),
          presentationTitle(truncateSingleLine(script, 120)),
        ),
      };
    }
    default: {
      const detail = firstScalarString(input);
      const presentation = toolPresentation(tool);
      return {
        item: {
          type: "tool",
          tool,
          ...(typeof args.arguments === "string"
            ? { args: { script: args.arguments } }
            : { args: input }),
        },
        presentation:
          detail === undefined ? presentation : withTitle(presentation, presentationTitle(detail)),
      };
    }
  }
}

/** The terminal row, when the result carries shape the call did not (exit code, patch outcome). */
export function rowForToolResult(args: {
  opened: TimelineRow;
  tool: string;
  resultText: string;
  structuredResult: unknown;
}): TimelineRow | undefined {
  const { opened, resultText, structuredResult } = args;
  const item = opened.item;
  switch (item.type) {
    case "tool": {
      const structured =
        typeof structuredResult === "object" &&
        structuredResult !== null &&
        Object.keys(structuredResult).length > 0
          ? structuredResult
          : undefined;
      const result = structured ?? (resultText.length > 0 ? resultText : undefined);
      return result === undefined ? undefined : { ...opened, item: { ...item, result } };
    }
    case "delegation": {
      const summary = truncateSingleLine(resultText, 200);
      return summary.length === 0 ? undefined : { ...opened, item: { ...item, summary } };
    }
    default:
      // command output and exit code ride the generic close fields
      // (aggregatedOutput, exitCode); fileChange/planSteps/imageView terminal
      // shapes equal their opened shapes.
      return undefined;
  }
}

/**
 * Parse the `*** Begin Patch` envelope into `fileChange` entries.
 *
 * Codex's patch format: `*** Add File: p` / `*** Update File: p` /
 * `*** Delete File: p` / `*** Move to: p`, with `+`/`-`/` ` body lines. Total:
 * an unparseable envelope yields one entry with the raw text as the diff rather
 * than throwing, because a malformed patch is still a thing the user must see.
 */
export function parseApplyPatch(
  patch: string,
): Array<{ path: string; kind: "add" | "delete" | "update"; diff?: string; movePath?: string }> {
  const entries: Array<{
    path: string;
    kind: "add" | "delete" | "update";
    diff?: string;
    movePath?: string;
  }> = [];
  let current: {
    path: string;
    kind: "add" | "delete" | "update";
    movePath?: string;
    body: string[];
  } | null = null;
  const finish = (): void => {
    if (current === null) return;
    entries.push({
      path: current.path,
      kind: current.kind,
      ...(current.body.length === 0 ? {} : { diff: current.body.join("\n") }),
      ...(current.movePath === undefined ? {} : { movePath: current.movePath }),
    });
    current = null;
  };
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.*)$/.exec(line);
    if (header !== null) {
      finish();
      const kind = header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update";
      current = { path: header[2]!, kind, body: [] };
      continue;
    }
    const move = /^\*\*\* Move to: (.*)$/.exec(line);
    if (move !== null) {
      if (current !== null) current.movePath = move[1]!;
      continue;
    }
    if (line.startsWith("*** ")) continue;
    if (current !== null) current.body.push(line);
  }
  finish();
  if (entries.length === 0 && patch.trim().length > 0) {
    return [{ path: "(unparsed patch)", kind: "update", diff: patch }];
  }
  return entries;
}

/**
 * The flattened text of a `tool.result` body: a plain string, or the joined
 * `text` of the content blocks.
 */
export function resultBodyText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!Array.isArray(result)) return "";
  return result
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("");
}

/** `structured_result.exit_code` when the tool reports one (`exec_command` does). */
export function resultExitCode(structuredResult: unknown): number | undefined {
  if (typeof structuredResult !== "object" || structuredResult === null) return undefined;
  const exitCode = (structuredResult as { exit_code?: unknown }).exit_code;
  return typeof exitCode === "number" ? exitCode : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function planSteps(
  value: unknown,
): { step: string; status: "active" | "completed" | "failed" | "pending" }[] {
  if (!Array.isArray(value)) return [];
  const steps: { step: string; status: "active" | "completed" | "failed" | "pending" }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { step?: unknown; status?: unknown };
    const step = stringValue(record.step);
    if (step === undefined) continue;
    steps.push({ step, status: planStatus(stringValue(record.status)) });
  }
  return steps;
}

function planStatus(value: string | undefined): "active" | "completed" | "failed" | "pending" {
  switch (value) {
    case "in_progress":
    case "in-progress":
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstScalarString(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}
