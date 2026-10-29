import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isOracleReportId, type OracleReport } from "./oracle-directive.ts";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
// JSON string escaping can expand one input byte to `\u0000` (six bytes).
const MAX_REPORT_BYTES = (MAX_RESPONSE_BYTES + MAX_REQUEST_BYTES) * 6 + 4096;

export interface OracleReportStore {
  start(input: unknown): string | null;
  /** Settles a running report. False once it is settled, so the first body wins. */
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
    complete: (reportId, content, isError) =>
      completeOracleReport(reportId, content, isError, directory),
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
    createdAt: new Date().toISOString(),
  };
  return writeOracleReport(report, directory) ? id : null;
}

export function completeOracleReport(
  reportId: string,
  content: unknown,
  isError: boolean,
  directory = defaultOracleReportDir(),
): boolean {
  const report = loadOracleReport(reportId, directory);
  if (report === null || report.status !== "running") return false;
  const response = textContent(content);
  report.response =
    response !== null && Buffer.byteLength(response, "utf8") <= MAX_RESPONSE_BYTES
      ? response
      : "Oracle returned no card-renderable text. Open the native tool result for the complete output.";
  report.status = isError ? "error" : "completed";
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
  if (
    report.id !== reportId ||
    typeof report.response !== "string" ||
    Buffer.byteLength(report.response, "utf8") > MAX_RESPONSE_BYTES ||
    (report.status !== "running" && report.status !== "completed" && report.status !== "error") ||
    typeof report.createdAt !== "string"
  )
    return null;
  const request =
    typeof report.request === "string" &&
    Buffer.byteLength(report.request, "utf8") <= MAX_REQUEST_BYTES
      ? report.request
      : null;
  return {
    id: reportId,
    request,
    response: report.response,
    status: report.status,
    createdAt: report.createdAt,
  };
}
