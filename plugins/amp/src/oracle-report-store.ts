import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isOracleReportId,
  type OracleReport,
  type OracleTraceEvent,
  type OracleTraceKind,
  type OracleReportStatus,
} from "./oracle-directive.ts";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TRACE_BYTES = 512 * 1024;
const MAX_TRACE_EVENTS = 200;
const MAX_TRACE_FIELD_BYTES = 32 * 1024;
// JSON string escaping can expand one input byte to `\u0000` (six bytes).
const MAX_REPORT_BYTES = (MAX_RESPONSE_BYTES + MAX_REQUEST_BYTES + MAX_TRACE_BYTES) * 6 + 4096;

export interface OracleTraceEventInput {
  toolCallId?: string | null;
  kind: OracleTraceKind;
  title: string;
  content?: string | null;
  status?: OracleReportStatus | null;
}

export interface OracleReportStore {
  start(input: unknown): string | null;
  append(reportId: string, event: OracleTraceEventInput): boolean;
  complete(reportId: string, content: unknown, isError: boolean): boolean;
}

export function defaultOracleReportDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "bb-plugin-amp", "oracle");
}

export function createFileOracleReportStore(
  directory = defaultOracleReportDir(),
): OracleReportStore {
  return {
    start: (input) => startOracleReport(input, directory),
    append: (reportId, event) => appendOracleTrace(reportId, event, directory),
    complete: (reportId, content, isError) => completeOracleReport(
      reportId,
      content,
      isError,
      directory,
    ),
  };
}

export function startOracleReport(
  input: unknown,
  directory = defaultOracleReportDir(),
): string | null {
  const id = randomUUID();
  const report: OracleReport = {
    id,
    request: requestText(input),
    response: "",
    status: "running",
    trace: [],
    createdAt: new Date().toISOString(),
  };
  return writeOracleReport(report, directory) ? id : null;
}

export function appendOracleTrace(
  reportId: string,
  event: OracleTraceEventInput,
  directory = defaultOracleReportDir(),
): boolean {
  const report = loadOracleReport(reportId, directory);
  if (report === null || report.status !== "running") return false;
  const normalized = normalizeTraceEvent(event);
  if (normalized === null) return false;
  let runningTool: OracleTraceEvent | undefined;
  if (normalized.kind === "tool" && normalized.toolCallId !== null) {
    for (let index = report.trace.length - 1; index >= 0; index--) {
      const candidate = report.trace[index];
      if (candidate.kind === "tool"
        && candidate.toolCallId === normalized.toolCallId
        && candidate.status === "running") {
        runningTool = candidate;
        break;
      }
    }
  }
  if (runningTool && normalized.status !== "running") {
    runningTool.status = normalized.status;
    runningTool.createdAt = normalized.createdAt;
  } else {
    report.trace.push(normalized);
  }
  while (report.trace.length > MAX_TRACE_EVENTS
    || Buffer.byteLength(JSON.stringify(report.trace), "utf8") > MAX_TRACE_BYTES) {
    report.trace.shift();
  }
  return writeOracleReport(report, directory);
}

export function completeOracleReport(
  reportId: string,
  content: unknown,
  isError: boolean,
  directory = defaultOracleReportDir(),
): boolean {
  const report = loadOracleReport(reportId, directory);
  if (report === null) return false;
  const response = textContent(content);
  report.response = response !== null && Buffer.byteLength(response, "utf8") <= MAX_RESPONSE_BYTES
    ? response
    : "Oracle returned no card-renderable text. Open the native tool result for the complete output.";
  report.status = isError ? "error" : "completed";
  const completedAt = new Date().toISOString();
  for (const event of report.trace) {
    if (event.kind === "tool" && event.status === "running") {
      event.status = report.status;
      event.createdAt = completedAt;
    }
  }
  return writeOracleReport(report, directory);
}

export function loadOracleReport(
  reportId: string,
  directory = defaultOracleReportDir(),
): OracleReport | null {
  if (!isOracleReportId(reportId)) return null;
  const reportPath = join(directory, `${reportId}.json`);
  try {
    if (statSync(reportPath).size > MAX_REPORT_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    return parseOracleReport(parsed, reportId);
  } catch {
    return null;
  }
}

function textContent(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const block = entry as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" && block.text.length > 0
      ? [block.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function requestText(input: unknown): string | null {
  let request: string | null = typeof input === "string" ? input : null;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["task", "prompt", "question"]) {
      if (typeof record[key] === "string") {
        request = record[key];
        break;
      }
    }
  }
  const normalized = request?.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= MAX_REQUEST_BYTES
    ? normalized
    : null;
}

function normalizeTraceEvent(event: OracleTraceEventInput): OracleTraceEvent | null {
  const title = boundedTraceText(event.title);
  if (title === null) return null;
  const content = event.content == null ? null : boundedTraceText(event.content);
  return {
    id: randomUUID(),
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : null,
    kind: event.kind,
    title,
    content,
    status: event.status ?? null,
    createdAt: new Date().toISOString(),
  };
}

function boundedTraceText(value: string): string | null {
  const text = value.trim();
  return text.length > 0 && Buffer.byteLength(text, "utf8") <= MAX_TRACE_FIELD_BYTES
    ? text
    : null;
}

function writeOracleReport(report: OracleReport, directory: string): boolean {
  const reportPath = join(directory, `${report.id}.json`);
  const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(report)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) return false;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, reportPath);
    return true;
  } catch (error) {
    console.error("[amp] failed to persist Oracle report", error);
    return false;
  }
}

function parseOracleReport(value: unknown, reportId: string): OracleReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (report.id !== reportId
    || typeof report.response !== "string"
    || Buffer.byteLength(report.response, "utf8") > MAX_RESPONSE_BYTES
    || (report.status !== "running" && report.status !== "completed" && report.status !== "error")
    || typeof report.createdAt !== "string") return null;
  const request = typeof report.request === "string"
    && Buffer.byteLength(report.request, "utf8") <= MAX_REQUEST_BYTES
    ? report.request
    : null;
  return {
    id: reportId,
    request,
    response: report.response,
    status: report.status,
    trace: Array.isArray(report.trace)
      ? report.trace.flatMap((event) => {
        const parsed = parseTraceEvent(event);
        return parsed === null ? [] : [parsed];
      }).slice(-MAX_TRACE_EVENTS)
      : [],
    createdAt: report.createdAt,
  };
}

function parseTraceEvent(value: unknown): OracleTraceEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string"
    || (event.toolCallId != null && typeof event.toolCallId !== "string")
    || (event.kind !== "thinking" && event.kind !== "message" && event.kind !== "tool")
    || typeof event.title !== "string"
    || Buffer.byteLength(event.title, "utf8") > MAX_TRACE_FIELD_BYTES
    || (event.content !== null && typeof event.content !== "string")
    || (typeof event.content === "string"
      && Buffer.byteLength(event.content, "utf8") > MAX_TRACE_FIELD_BYTES)
    || (event.status !== null
      && event.status !== "running"
      && event.status !== "completed"
      && event.status !== "error")
    || typeof event.createdAt !== "string") return null;
  return {
    id: event.id,
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : null,
    kind: event.kind,
    title: event.title,
    content: typeof event.content === "string" ? event.content : null,
    status: event.status,
    createdAt: event.createdAt,
  };
}
