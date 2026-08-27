/**
 * `src/bridge/project.ts` — `AmpEvent` → scribe calls.
 *
 * Pure in the sense that matters: it performs no I/O, spawns nothing, and its
 * only effect is calling methods on the `TurnScribe` (and the two writer
 * callbacks) it is handed. A stream test feeds it a real scribe wired to
 * `experimental_createBridgeDeltaEventCollector` and asserts the assembled
 * `ThreadEvent`s.
 *
 * This is the concentration point that `translate.ts` never was: the switch
 * is exhaustive over a closed union and there is no post-processing step in
 * the conversation layer.
 */

import {
  experimental_toolPresentation as toolPresentation,
  type JsonValue,
  type ProviderErrorCategory,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AmpErrorSubtype, AmpEvent, AmpToolOutput, AmpUsage } from "./events.ts";
import { AMP_ORACLE_KIND, describeAmpTool, imageRow, oracleRow, terminalRow } from "./shapes.ts";
import type { OpenItem, TimelineRow, TurnScribe } from "./timeline.ts";

/** The Oracle file-store surface this projector needs. `begin` returns null
 *  when the store cannot persist a report (deviation from the sketch: a card
 *  whose body would 404 falls back to a plain tool row instead). */
export interface OracleReports {
  begin(question: string): { reportId: string; write: (text: string) => void } | null;
  finish(reportId: string, status: "completed" | "error"): void;
}

/**
 * Per-turn projection state. Lives beside the scribe, not inside it, because
 * it is Amp vocabulary (Amp tool ids, Oracle report ids) and the scribe is
 * deliberately Amp-free.
 */
export interface ProjectionContext {
  readonly scribe: TurnScribe;
  /** Amp tool-use id → the handle `openItem` minted for it. */
  readonly open: Map<string, OpenItem>;
  /** Amp tool-use id → the row as opened; `terminalRow` merges the output
   *  into it at close. */
  readonly rows: Map<string, TimelineRow>;
  /** Amp tool-use id → the Oracle report opened for that call. */
  readonly oracleByCallId: Map<string, { reportId: string; write: (text: string) => void }>;
  readonly oracle: OracleReports;
  /** Amp tool names that are bb dynamic tools proxied through MCP
   *  (`mcp__bb-bridge__<id>`); those rows render with `server: "bb"`. */
  readonly bbToolIds: ReadonlySet<string>;
  /** Fallback working directory for `command` rows (grammar v3 requires
   *  `cwd`). */
  readonly cwd: string;
  /** Routes an Amp usage reading to `ThreadWriter.addUsage` after mapping. */
  readonly addUsage: (usage: AmpUsage) => void;
  /** Routes unparsed lines to `ThreadWriter.raw`. */
  readonly raw: (payload: JsonValue, coverage: "noise" | "unknown") => void;
}

/**
 * Project one event. Exhaustive: adding an `AmpEvent` member without handling
 * it here is a type error.
 */
export function projectAmpEvent(event: AmpEvent, ctx: ProjectionContext): void {
  switch (event.kind) {
    case "init": {
      // A `bb-bridge` server that failed to attach is the one condition where
      // bb's tools are silently missing from Amp's roster: a real warning row
      // instead of today's fake assistant message.
      for (const server of event.mcpServers) {
        if (server.name === "bb-bridge" && server.status !== "connected") {
          ctx.scribe.warn({
            category: "config",
            summary: "bb tools unavailable",
            details: `Amp reports MCP server "${server.name}" as "${server.status}"; bb dynamic tools are missing from this turn.`,
          });
        }
      }
      return;
    }
    case "text":
      ctx.scribe.say(event.text);
      return;
    case "thinking":
      ctx.scribe.think(event.text);
      return;
    case "image":
      ctx.scribe.recordItem(ctx.scribe.mintKey("image"), imageRow(event.image), {
        status: "completed",
      });
      return;
    case "toolStart": {
      const row = rowForToolStart(event, ctx);
      ctx.rows.set(event.callId, row);
      ctx.open.set(event.callId, ctx.scribe.openItem(event.callId, row));
      return;
    }
    case "toolEnd": {
      const report = ctx.oracleByCallId.get(event.callId);
      if (report !== undefined) {
        ctx.oracleByCallId.delete(event.callId);
        // Write the body BEFORE closing, so the renderer never sees a
        // completed card with no body.
        const body = oracleBody(event.output);
        if (body.length > 0) report.write(body);
      }
      const handle = ctx.open.get(event.callId);
      const openedRow = ctx.rows.get(event.callId);
      ctx.open.delete(event.callId);
      ctx.rows.delete(event.callId);
      const status = event.failed ? ("failed" as const) : ("completed" as const);
      if (handle === undefined || openedRow === undefined) {
        // Close without an open: a resumed Amp thread replaying history.
        ctx.scribe.recordItem(event.callId, orphanRow(), {
          status,
          ...(event.output.text.length > 0 ? { resultText: event.output.text } : {}),
        });
        return;
      }
      const row = terminalRow(openedRow, {
        text: event.output.text,
        structured: event.output.structured,
        failed: event.failed,
      });
      const isCommand = openedRow.item.type === "command";
      ctx.scribe.closeItem(handle, {
        status,
        row,
        ...(event.output.text.length > 0 ? { resultText: event.output.text } : {}),
        // aggregatedOutput only for execute-kind tools: for `command` the
        // generic close fields win over the shape's own.
        ...(isCommand && event.output.text.length > 0
          ? { aggregatedOutput: event.output.text }
          : {}),
        ...(isCommand ? exitCodeOutcome(event.output.structured) : {}),
      });
      return;
    }
    case "userEcho":
      // The conversation supervisor consumes it; no timeline row.
      return;
    case "assistantStop":
      // Settlement is driven by `result`, the only line that means the CLI is
      // done. Treating `end_turn` as terminal is how the ACP bridge ends up
      // settling before the tool results arrive.
      return;
    case "usage":
      ctx.addUsage(event.usage);
      return;
    case "resultOk":
      warnDenials(ctx, event.denials);
      return;
    case "resultError":
      warnDenials(ctx, event.denials);
      ctx.scribe.fail({
        message: event.message,
        settlesTurn: true,
        category: categoryFor(event.subtype),
      });
      return;
    case "raw":
      ctx.raw(event.payload, event.coverage);
      return;
    default: {
      const unhandled: never = event;
      throw new Error(`unreachable amp event: ${JSON.stringify(unhandled)}`);
    }
  }
}

function rowForToolStart(
  event: Extract<AmpEvent, { kind: "toolStart" }>,
  ctx: ProjectionContext,
): TimelineRow {
  if (event.tool.toLowerCase() === "oracle") {
    const question = oracleQuestion(event.input);
    const report = ctx.oracle.begin(question);
    if (report !== null) {
      ctx.oracleByCallId.set(event.callId, report);
      return oracleRow({
        reportId: report.reportId,
        question,
        onSettle: (status) =>
          ctx.oracle.finish(report.reportId, status === "completed" ? "completed" : "error"),
      });
    }
  }
  return describeAmpTool({
    tool: event.tool,
    input: event.input,
    callId: event.callId,
    cwd: ctx.cwd,
    bbToolIds: ctx.bbToolIds,
  });
}

function warnDenials(ctx: ProjectionContext, denials: readonly string[]): void {
  if (denials.length === 0) return;
  ctx.scribe.warn({
    category: "config",
    summary: `Amp denied ${denials.length} tool call${denials.length === 1 ? "" : "s"}`,
    details: denials.join("\n"),
  });
}

/** The first line of the Oracle question, for the card headline and the
 *  report request field. */
function oracleQuestion(input: JsonValue): string {
  let text: string | undefined;
  if (typeof input === "string") text = input;
  else if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    for (const key of ["task", "prompt", "question", "query"]) {
      const value = input[key];
      if (typeof value === "string" && value.length > 0) {
        text = value;
        break;
      }
    }
  }
  const firstLine = text?.trim().split("\n", 1)[0]?.trim();
  return firstLine !== undefined && firstLine.length > 0 ? firstLine : "Oracle";
}

/** Text rendering of an Oracle result: structured text blocks when present,
 *  the plain text otherwise. */
function oracleBody(output: AmpToolOutput): string {
  if (typeof output.structured === "string") return output.structured;
  if (Array.isArray(output.structured)) {
    const parts = output.structured.flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      entry.type === "text" &&
      typeof entry.text === "string"
        ? [entry.text]
        : [],
    );
    if (parts.length > 0) return parts.join("\n");
  }
  return output.text;
}

function exitCodeOutcome(
  structured: JsonValue | null,
): { exitCode: number } | Record<string, never> {
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) return {};
  const value = structured.exitCode ?? structured.exit_code;
  return typeof value === "number" && Number.isInteger(value) ? { exitCode: value } : {};
}

/** A `toolEnd` with no matching open: the tool name is gone, so the row is a
 *  generic tool. */
function orphanRow(): TimelineRow {
  return { item: { type: "tool", tool: "unknown" }, presentation: toolPresentation("tool") };
}

function categoryFor(subtype: AmpErrorSubtype): ProviderErrorCategory {
  switch (subtype) {
    case "auth_required":
      return "unauthorized";
    case "error_max_turns":
      return "max-turns";
    case "unsupported_option":
      return "bad-request";
    case "error_during_execution":
      return "internal";
    case "unknown":
      return "unknown";
  }
}

export { AMP_ORACLE_KIND };
