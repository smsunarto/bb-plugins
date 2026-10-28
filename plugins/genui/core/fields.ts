// Readers for tool reports (Findings, Coverage): fields of plain data
// objects, read without trusting the shape. Pure: no React, no DOM.
import type { Value } from "./types";

/** A plain data object's fields; absent keys read as undefined. */
export type Fields = Readonly<Record<string, Value | undefined>>;

/** `value` as a plain data object, or null for scalars, lists and the interpreter's node/action/binding shapes. */
export function fieldsOf(value: Value | undefined): Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if ("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding")) return null;
  return value as Fields;
}

/** A non-blank string (numbers as their text), else null. */
export function str(value: Value | undefined): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A finite number, also from a numeric string. */
export function num(value: Value | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/** A whole number ≥ 1 (a line or column), else null. */
export function positiveInteger(value: Value | undefined): number | null {
  const n = num(value);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A whole number ≥ 0 (a count), else null. */
export function count(value: Value | undefined): number | null {
  const n = num(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function listOf(value: Value | undefined): readonly Value[] {
  return Array.isArray(value) ? value : [];
}

/** Text lines of a report with `\r\n` and ANSI colour codes gone. */
export function plainLines(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
}

/** `file://` URIs as paths (percent-decoded), Windows separators as `/`; other paths as given. */
export function reportPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith("file://")) {
    path = path.slice(7);
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the undecoded text.
    }
    // file:///C:/x → C:/x
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  if (/^[A-Za-z]:\\/.test(path) || (path.includes("\\") && !path.includes("/"))) path = path.replace(/\\/g, "/");
  return path;
}
