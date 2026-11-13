/**
 * Dotenv reconciliation, ported from bb's builtin Secrets plugin (0.49.0) with
 * the same behaviour: existing assignments are rewritten in place (keeping
 * `export`, spacing, and trailing comments), new names are appended, and any
 * file this cannot rewrite safely is refused rather than guessed at.
 */

export interface ReconcileResult {
  content: string;
  added: number;
  updated: number;
  unchanged: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assignmentPattern(name: string): RegExp {
  return new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=\\s*)(.*)$`, "u");
}

const ANY_ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/u;

function hasClosingQuote(value: string, quote: string): boolean {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) return true;
  }
  return false;
}

function assertNoMultilineQuotedAssignments(content: string): void {
  for (const line of content.split(/\r?\n/u)) {
    const value = ANY_ASSIGNMENT.exec(line)?.[1] ?? "";
    const quote = value[0];
    if ((quote === "'" || quote === '"') && !hasClosingQuote(value, quote)) {
      throw new Error("Dotenv files with multiline quoted values cannot be reconciled safely.");
    }
  }
}

export function assertReconcilable(content: string, names: readonly string[]): void {
  assertNoMultilineQuotedAssignments(content);
  const lines = content.split(/\r?\n/u);
  for (const name of names) {
    const pattern = assignmentPattern(name);
    if (lines.filter((line) => pattern.test(line)).length > 1) {
      throw new Error(`Dotenv file contains duplicate assignments for ${name}.`);
    }
  }
}

export function encodeValue(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/u.test(value)) return `"${value}"`;
  if (value === value.trim() && !value.includes("#")) return value;
  throw new Error("A secret value cannot be represented safely in a single dotenv assignment.");
}

function isCommentStart(rest: string, index: number, quote: string | null): boolean {
  return rest[index] === "#" && quote === null && index > 0 && /\s/u.test(rest[index - 1] ?? "");
}

function trailingComment(rest: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else quote ??= char;
      continue;
    }
    if (!isCommentStart(rest, index, quote)) continue;
    let start = index;
    while (start > 0 && /\s/u.test(rest[start - 1] ?? "")) start -= 1;
    return rest.slice(start);
  }
  return "";
}

export function reconcileDotenv(
  content: string,
  values: Readonly<Record<string, string>>,
): ReconcileResult {
  const names = Object.keys(values);
  assertReconcilable(content, names);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const endsWithEol = content.endsWith("\n");
  const lines = content.length === 0 ? [] : content.split(/\r?\n/u);
  if (endsWithEol) lines.pop();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const missing = new Set(names);
  const next = lines.map((line) => {
    for (const name of names) {
      const match = assignmentPattern(name).exec(line);
      if (!match) continue;
      missing.delete(name);
      const rewritten = `${match[1]}${encodeValue(values[name] ?? "")}${trailingComment(match[2] ?? "")}`;
      if (rewritten === line) unchanged += 1;
      else updated += 1;
      return rewritten;
    }
    return line;
  });
  for (const name of names) {
    if (missing.has(name)) {
      next.push(`${name}=${encodeValue(values[name] ?? "")}`);
      added += 1;
    }
  }
  const joined = next.join(eol);
  return {
    content: joined.length === 0 ? "" : `${joined}${endsWithEol || added > 0 ? eol : ""}`,
    added,
    updated,
    unchanged,
  };
}
