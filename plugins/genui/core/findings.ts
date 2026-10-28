// What `Findings` shows, from the shapes it takes: a hand-written list
// (`[{severity, title, file?, line?, column?, detail?, fix?, rule?, url?,
// status?, owner?, round?}]`), a review (`{game? | subject?, verdict,
// findings: [{severity: P0–P3, area, issue, evidence, fix, status?}],
// evidence?, artifacts?}`), ESLint's JSON formatter (`-f json` and
// `-f json-with-metadata`), SARIF 2.1 (semgrep, CodeQL,
// eslint-formatter-sarif…), `tsc --noEmit --pretty false` text, Ruff's JSON,
// oxlint's JSON and Biome's JSON reporter. Also how they sort and group, a
// review finding's lifecycle (open → fixed by its owner → confirmed by the
// reviewer, or rejected, deferred, won't fix), the fix as a patch where a
// tool gives edits, and the messages "Fix this" and "Fix all" send. Pure: no
// React, no DOM.
import { count, fieldsOf, listOf, plainLines, positiveInteger, reportPath, str, type Fields } from "./fields";
import type { Value } from "./types";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** Most severe first. */
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

/**
 * How a report names its severities: `risk` (critical, high, medium, low,
 * info) for reviews and security scanners, `lint` (error, warning, note,
 * info) for compilers and linters, `priority` (P0, P1, P2, P3, P4) for
 * reviews that rank by priority.
 */
export type SeverityScale = "risk" | "lint" | "priority";

const LINT_LABELS: Readonly<Record<Severity, string>> = { critical: "fatal", high: "error", medium: "warning", low: "note", info: "info" };
const PRIORITY_LABELS: Readonly<Record<Severity, string>> = { critical: "P0", high: "P1", medium: "P2", low: "P3", info: "P4" };

/** A severity as the report's tool would say it: `error`, `high`, `P1`… */
export function severityLabel(severity: Severity, scale: SeverityScale): string {
  return scale === "lint" ? LINT_LABELS[severity] : scale === "priority" ? PRIORITY_LABELS[severity] : severity;
}

/** `3 errors`, `1 warning`, `2 critical`, `1 info`. */
export function severityCount(severity: Severity, scale: SeverityScale, n: number): string {
  const label = severityLabel(severity, scale);
  const plural = n !== 1 && scale === "lint" && severity !== "info";
  return `${n} ${label}${plural ? "s" : ""}`;
}

/** A position in a file: a 0-based character offset, or a 1-based line and column. */
export type FilePosition = { readonly offset: number } | { readonly line: number; readonly column: number };

/** Replace the text from `start` up to (not including) `end` with `text`. */
export interface TextEdit {
  readonly start: FilePosition;
  readonly end: FilePosition;
  readonly text: string;
}

export type Fix =
  | { readonly kind: "patch"; readonly patch: string }
  | { readonly kind: "code"; readonly code: string }
  /** Edits a tool gave without the file's text; a patch once the file is read (editsPatch). */
  | { readonly kind: "edits"; readonly edits: readonly TextEdit[] }
  /** A reviewer's proposed fix in prose (a review's `fix`). */
  | { readonly kind: "proposal"; readonly text: string };

/**
 * Where a review finding stands: `open` (the default), `fixed` (its owner says
 * so; the reviewer has not confirmed it), `confirmed` (the reviewer confirmed
 * the fix), `rejected` (the owner disputes it, with counter-evidence),
 * `deferred` (handed to another owner, e.g. a shared kit), `wontfix`.
 */
export type FindingStatus = "open" | "deferred" | "fixed" | "confirmed" | "rejected" | "wontfix";

/** In the order a reader works through them: what needs a fix, what awaits confirmation, what is settled. */
export const STATUSES: readonly FindingStatus[] = ["open", "deferred", "fixed", "confirmed", "rejected", "wontfix"];

export interface Finding {
  readonly severity: Severity;
  readonly title: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly endLine: number | null;
  readonly endColumn: number | null;
  /** Markdown, or plain text (tsc's indented message chains) when `detailIsText`. */
  readonly detail: string | null;
  readonly detailIsText: boolean;
  readonly fix: Fix | null;
  /** What the fix does, in the tool's words ("Replace with `cond is None`"). */
  readonly fixNote: string | null;
  readonly rule: string | null;
  readonly url: string | null;
  /** The code at the location as the tool quoted it (SARIF `region.snippet`), for when the file can't be read. */
  readonly snippet: string | null;
  /** The reviewer's evidence for the finding (markdown). */
  readonly evidence: string | null;
  /** The finding's id in its review ("F3", "P1-2"). */
  readonly id: string | null;
  /** Null when the report gives no status: read as open. */
  readonly status: FindingStatus | null;
  /** Who owns the fix (a game owner, "shared shell"). */
  readonly owner: string | null;
  /** Who checked it (the reviewer who confirmed or the owner who rejected). */
  readonly by: string | null;
  /** The review or fix round ("2"). */
  readonly round: string | null;
  /** The revision the fix landed in. */
  readonly revision: string | null;
  /** What happened to it: the counter-evidence of a rejection, the reason of a deferral, the fix's note. */
  readonly note: string | null;
}

export type VerdictKind = "ship" | "fix-required" | "blocked" | "other";

/** A review's own words around its findings. */
export interface Review {
  /** What was reviewed: the game, slice or component. */
  readonly subject: string | null;
  readonly verdict: { readonly kind: VerdictKind; readonly text: string } | null;
  /** The reviewer's evidence for the review as a whole, one entry each. */
  readonly evidence: readonly string[];
  /** Files the review produced or relied on (screenshots, probes). */
  readonly artifacts: readonly string[];
}

export interface FindingsReport {
  /** The tool that produced it ("ESLint", "tsc", "semgrep"…); null for a hand-written list. */
  readonly tool: string | null;
  readonly scale: SeverityScale;
  readonly findings: readonly Finding[];
  /** List items without a title, left out. */
  readonly ignored: number;
  /** Present when the report is a review with a verdict, subject, evidence or artifacts. */
  readonly review?: Review;
}

export type FindingsResult = { readonly ok: true; readonly report: FindingsReport } | { readonly ok: false; readonly error: string };

const SHAPE_HINT = "Findings needs a list of {severity, title}, ESLint or Ruff JSON, SARIF, or tsc --pretty false output";

// ---------------------------------------------------------------------------
// Severity words

const SEVERITY_WORDS: Readonly<Record<string, Severity>> = {
  critical: "critical",
  fatal: "critical",
  blocker: "critical",
  high: "high",
  error: "high",
  err: "high",
  major: "high",
  severe: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  warn: "medium",
  low: "low",
  minor: "low",
  note: "low",
  hint: "low",
  advice: "low",
  style: "low",
  info: "info",
  information: "info",
  informational: "info",
  none: "info",
  suggestion: "info",
  p0: "critical",
  p1: "high",
  p2: "medium",
  p3: "low",
  p4: "info",
};

/** Words only reviews and scanners use: a list with any of them reads on the risk scale. */
const RISK_WORDS: Record<string, true> = {
  critical: true,
  high: true,
  medium: true,
  low: true,
  moderate: true,
  major: true,
  minor: true,
  blocker: true,
  severe: true,
};

function severityOf(value: Value | undefined): Severity | null {
  if (typeof value === "number") return value >= 2 ? "high" : value === 1 ? "medium" : null;
  const word = str(value)?.trim().toLowerCase();
  return word === undefined ? null : (SEVERITY_WORDS[word] ?? null);
}

/** The words a status takes, lowercased with spaces and underscores as `-` and apostrophes dropped. */
const STATUS_WORDS: Readonly<Record<string, FindingStatus>> = {
  open: "open",
  new: "open",
  todo: "open",
  reopened: "open",
  unresolved: "open",
  "in-progress": "open",
  wip: "open",
  pending: "open",
  fixed: "fixed",
  resolved: "fixed",
  addressed: "fixed",
  done: "fixed",
  "owner-fixed": "fixed",
  "fixed-unconfirmed": "fixed",
  "awaiting-confirmation": "fixed",
  confirmed: "confirmed",
  verified: "confirmed",
  "fix-confirmed": "confirmed",
  closed: "confirmed",
  rejected: "rejected",
  disputed: "rejected",
  invalid: "rejected",
  "not-a-bug": "rejected",
  "false-positive": "rejected",
  deferred: "deferred",
  shared: "deferred",
  "out-of-scope": "deferred",
  "handed-off": "deferred",
  wontfix: "wontfix",
  "wont-fix": "wontfix",
  "accepted-risk": "wontfix",
  ignored: "wontfix",
};

/**
 * A finding's status; a word it doesn't know reads as open (never as
 * settled), and no status at all as null.
 */
function statusOf(value: Value | undefined): FindingStatus | null {
  const word = str(value)?.trim().toLowerCase().replace(/['’]/g, "").replace(/[\s_]+/g, "-");
  return word === undefined ? null : (STATUS_WORDS[word] ?? "open");
}

/** SARIF / GitHub code scanning `security-severity` (CVSS-like 0–10) as a severity. */
function securitySeverity(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return score > 0 ? "low" : "info";
}

// ---------------------------------------------------------------------------
// One finding

function finding(fields: Partial<Finding> & { severity: Severity; title: string }): Finding {
  return {
    file: null,
    line: null,
    column: null,
    endLine: null,
    endColumn: null,
    detail: null,
    detailIsText: false,
    fix: null,
    fixNote: null,
    rule: null,
    url: null,
    snippet: null,
    evidence: null,
    id: null,
    status: null,
    owner: null,
    by: null,
    round: null,
    revision: null,
    note: null,
    ...fields,
  };
}

/** A unified patch rather than code: it has hunk or file headers. */
function looksLikePatch(text: string): boolean {
  return /^@@ -\d/m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text)) || /^diff --git /m.test(text);
}

/** `src/a.ts:12:3`, `src/a.ts:12` or `src/a.ts(12,3)` → its parts; anything else is all path. */
function splitLocation(raw: string): { file: string; line: number | null; column: number | null } {
  const match = /^(.+?)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))$/.exec(raw.trim());
  if (match === null || /^[A-Za-z]$/.test(match[1]!)) return { file: raw.trim(), line: null, column: null };
  const line = Number(match[2] ?? match[4]);
  const column = match[3] ?? match[5];
  return { file: match[1]!, line, column: column === undefined ? null : Number(column) };
}

/** Which scale a severity word reads on: P0–P3 on the priority scale, review words on the risk scale. */
function scaleWord(word: string | null): SeverityScale | null {
  const key = word?.trim().toLowerCase() ?? "";
  if (/^p[0-4]$/.test(key)) return "priority";
  return Object.hasOwn(RISK_WORDS, key) ? "risk" : null;
}

function listFinding(item: Value): { finding: Finding; scale: SeverityScale | null } | null {
  const fields = fieldsOf(item);
  if (fields === null) {
    const title = str(item);
    return title === null ? null : { finding: finding({ severity: "medium", title: title.trim() }), scale: null };
  }
  const title = str(fields.title) ?? str(fields.issue) ?? str(fields.message) ?? str(fields.name) ?? str(fields.summary);
  if (title === null) return null;
  const word = str(fields.severity) ?? str(fields.level) ?? str(fields.priority);
  const severity = severityOf(fields.severity ?? fields.level ?? fields.priority) ?? "medium";
  const where = str(fields.file) ?? str(fields.path) ?? str(fields.filename) ?? str(fields.location);
  const located = where === null ? null : splitLocation(where);
  const fixText = str(fields.fix) ?? str(fields.suggestion);
  const patch = fixText !== null && looksLikePatch(fixText);
  // A review's `fix` is the reviewer's proposal in prose; elsewhere it is code to apply.
  const proposal = fixText !== null && !patch && (fields.issue !== undefined || fields.area !== undefined);
  return {
    finding: finding({
      severity,
      title: title.trim(),
      file: located === null ? null : reportPath(located.file),
      line: positiveInteger(fields.line) ?? located?.line ?? null,
      column: positiveInteger(fields.column ?? fields.col) ?? located?.column ?? null,
      endLine: positiveInteger(fields.endLine),
      endColumn: positiveInteger(fields.endColumn),
      detail: str(fields.detail) ?? str(fields.description) ?? str(fields.body),
      fix: fixText === null ? null : proposal ? { kind: "proposal", text: fixText.trim() } : patch ? { kind: "patch", patch: fixText } : { kind: "code", code: fixText },
      rule: str(fields.rule) ?? str(fields.area) ?? str(fields.category) ?? str(fields.ruleId) ?? str(fields.check) ?? str(fields.code),
      url: str(fields.url) ?? str(fields.link) ?? str(fields.docs),
      evidence: str(fields.evidence),
      id: str(fields.id),
      status: statusOf(fields.status ?? fields.state),
      owner: str(fields.owner) ?? str(fields.assignee),
      by: str(fields.by) ?? str(fields.confirmedBy) ?? str(fields.verifiedBy) ?? str(fields.reviewer),
      round: str(fields.round),
      revision: str(fields.revision) ?? str(fields.commit) ?? str(fields.fixedIn) ?? str(fields.sha),
      note: str(fields.note) ?? str(fields.resolution) ?? str(fields.reason) ?? str(fields.counterEvidence),
    }),
    scale: scaleWord(word),
  };
}

function fromList(items: readonly Value[]): FindingsReport {
  const findings: Finding[] = [];
  let ignored = 0;
  let scale: SeverityScale = "lint";
  for (const item of items) {
    const read = listFinding(item);
    if (read === null) {
      ignored++;
      continue;
    }
    findings.push(read.finding);
    // P0–P3 win over risk words, which win over lint words.
    if (read.scale === "priority" || (read.scale === "risk" && scale === "lint")) scale = read.scale;
  }
  return { tool: null, scale, findings, ignored };
}

// ---------------------------------------------------------------------------
// ESLint

/** The docs page of an ESLint rule, for the core rules and the common plugins. */
function eslintRuleUrl(rule: string): string | null {
  if (/^[a-z-]+$/.test(rule)) return `https://eslint.org/docs/latest/rules/${rule}`;
  const scoped = /^(@[\w-]+(?:\/[\w-]+)?|[\w-]+)\/([\w-]+)$/.exec(rule);
  if (scoped === null) return null;
  const [, plugin, name] = scoped;
  switch (plugin) {
    case "@typescript-eslint":
      return `https://typescript-eslint.io/rules/${name}`;
    case "@stylistic":
      return `https://eslint.style/rules/${name}`;
    case "react-hooks":
      return `https://react.dev/reference/eslint-plugin-react-hooks/lints/${name}`;
    case "react":
      return `https://github.com/jsx-eslint/eslint-plugin-react/blob/master/docs/rules/${name}.md`;
    case "import":
      return `https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/${name}.md`;
    case "jsx-a11y":
      return `https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/blob/main/docs/rules/${name}.md`;
    case "unicorn":
      return `https://github.com/sindresorhus/eslint-plugin-unicorn/blob/main/docs/rules/${name}.md`;
    default:
      return null;
  }
}

function isEslintResults(value: Value | undefined): value is readonly Value[] {
  if (!Array.isArray(value)) return false;
  const first = fieldsOf(value[0]);
  return first !== null && typeof first.filePath === "string" && Array.isArray(first.messages);
}

function eslintEdit(fix: Fields | null): TextEdit | null {
  const range = listOf(fix?.range);
  const start = count(range[0]);
  const end = count(range[1]);
  const text = fix?.text;
  if (start === null || end === null || end < start || typeof text !== "string") return null;
  return { start: { offset: start }, end: { offset: end }, text };
}

function fromEslint(results: readonly Value[], docs: Fields | null): FindingsReport {
  const findings: Finding[] = [];
  for (const result of results) {
    const file = fieldsOf(result);
    const path = str(file?.filePath);
    if (file === null || path === null) continue;
    const source = typeof file.source === "string" ? file.source : null;
    for (const raw of listOf(file.messages)) {
      const message = fieldsOf(raw);
      const title = str(message?.message);
      if (message === null || title === null) continue;
      const rule = str(message.ruleId);
      const fatal = message.fatal === true;
      let edit = eslintEdit(fieldsOf(message.fix));
      let fixNote: string | null = null;
      if (edit === null) {
        // A suggestion is the fix ESLint offers but won't apply on its own.
        const suggestion = fieldsOf(listOf(message.suggestions)[0]);
        edit = eslintEdit(fieldsOf(suggestion?.fix));
        if (edit !== null) fixNote = str(suggestion?.desc);
      }
      const shown = path.replace(/\\/g, "/");
      const fix: Fix | null =
        edit === null ? null : source !== null ? patchFix(source, shown, [edit]) : { kind: "edits", edits: [edit] };
      const meta = rule === null ? null : fieldsOf(docs?.[rule]);
      findings.push(
        finding({
          severity: fatal ? "high" : (severityOf(message.severity) ?? "medium"),
          title: title.trim(),
          file: reportPath(path),
          line: positiveInteger(message.line),
          column: positiveInteger(message.column),
          endLine: positiveInteger(message.endLine),
          endColumn: positiveInteger(message.endColumn),
          detail: str(fieldsOf(meta?.docs)?.description),
          fix,
          fixNote,
          rule,
          url: str(fieldsOf(meta?.docs)?.url) ?? (rule === null ? null : eslintRuleUrl(rule)),
        }),
      );
    }
  }
  return { tool: "ESLint", scale: "lint", findings, ignored: 0 };
}

/** A patch fix from edits and the file's text, or the edits as they are when they don't apply. */
function patchFix(source: string, path: string, edits: readonly TextEdit[]): Fix {
  const patch = editsPatch(source, path, edits);
  return patch === null ? { kind: "edits", edits } : { kind: "patch", patch };
}

// ---------------------------------------------------------------------------
// SARIF 2.1

function sarifText(message: Fields | null, rule: Fields | null): string | null {
  if (message === null) return null;
  let text = str(message.text) ?? str(message.markdown);
  const id = str(message.id);
  if (text === null && id !== null) text = str(fieldsOf(fieldsOf(rule?.messageStrings)?.[id])?.text);
  if (text === null) return null;
  const args = listOf(message.arguments);
  return text
    .replace(/\{(\d+)\}/g, (whole, index: string) => str(args[Number(index)]) ?? whole)
    .replace(/\[([^\]]+)\]\(\d+\)/g, "$1");
}

function sarifUri(location: Fields | null, run: Fields): string | null {
  if (location === null) return null;
  let uri = str(location.uri);
  const index = count(location.index);
  if (uri === null && index !== null) {
    uri = str(fieldsOf(fieldsOf(listOf(run.artifacts)[index])?.location)?.uri);
  }
  if (uri === null) return null;
  const base = str(location.uriBaseId);
  const baseUri = base === null ? null : str(fieldsOf(fieldsOf(run.originalUriBaseIds)?.[base])?.uri);
  if (baseUri !== null && baseUri.startsWith("file://") && !/^[a-z]+:/i.test(uri)) {
    uri = `${baseUri.endsWith("/") ? baseUri : `${baseUri}/`}${uri}`;
  }
  return reportPath(uri.startsWith("file://") ? uri : safeDecode(uri));
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A SARIF region as a start and end position: lines and columns, else character offsets. */
function sarifRange(region: Fields | null): { start: FilePosition; end: FilePosition } | null {
  if (region === null) return null;
  const startLine = positiveInteger(region.startLine);
  if (startLine !== null) {
    const startColumn = positiveInteger(region.startColumn) ?? 1;
    const endLine = positiveInteger(region.endLine) ?? startLine;
    const endColumn = positiveInteger(region.endColumn);
    return {
      start: { line: startLine, column: startColumn },
      // No end column: the region runs to the end of its last line.
      end: endColumn === null ? { line: endLine + 1, column: 1 } : { line: endLine, column: endColumn },
    };
  }
  const offset = count(region.charOffset);
  if (offset === null) return null;
  return { start: { offset }, end: { offset: offset + (count(region.charLength) ?? 0) } };
}

/** The first fix's edits to the finding's own file (the first artifact it changes). */
function sarifFix(fixes: Value | undefined): { fix: Fix | null; note: string | null } {
  const first = fieldsOf(listOf(fixes)[0]);
  if (first === null) return { fix: null, note: null };
  const edits: TextEdit[] = [];
  for (const raw of listOf(fieldsOf(listOf(first.artifactChanges)[0])?.replacements)) {
    const replacement = fieldsOf(raw);
    const range = sarifRange(fieldsOf(replacement?.deletedRegion));
    if (range === null) continue;
    const inserted = fieldsOf(replacement?.insertedContent)?.text;
    edits.push({ ...range, text: typeof inserted === "string" ? inserted : "" });
  }
  return { fix: edits.length === 0 ? null : { kind: "edits", edits }, note: sarifText(fieldsOf(first.description), null) };
}

function fromSarif(log: Fields): FindingsReport {
  const findings: Finding[] = [];
  const tools = new Set<string>();
  let risk = false;
  for (const rawRun of listOf(log.runs)) {
    const run = fieldsOf(rawRun);
    if (run === null) continue;
    const driver = fieldsOf(fieldsOf(run.tool)?.driver);
    const name = str(driver?.name);
    if (name !== null) tools.add(name);
    const rules = listOf(driver?.rules).map(fieldsOf);
    const byId = new Map<string, Fields>();
    for (const rule of rules) {
      const id = str(rule?.id);
      if (rule !== null && id !== null) byId.set(id, rule);
    }
    for (const rawResult of listOf(run.results)) {
      const result = fieldsOf(rawResult);
      if (result === null) continue;
      const kind = str(result.kind) ?? "fail";
      if (kind === "pass" || kind === "notApplicable") continue;
      if (listOf(result.suppressions).length > 0) continue;
      const ruleId = str(result.ruleId) ?? str(fieldsOf(result.rule)?.id);
      const ruleIndex = count(result.ruleIndex) ?? count(fieldsOf(result.rule)?.index);
      const rule = (ruleId === null ? null : byId.get(ruleId)) ?? (ruleIndex === null ? null : rules[ruleIndex]) ?? null;
      const text = sarifText(fieldsOf(result.message), rule);
      const shortDescription = str(fieldsOf(rule?.shortDescription)?.text);
      const fullTitle = text ?? shortDescription ?? ruleId;
      if (fullTitle === null) continue;
      const [titleLine, ...rest] = fullTitle.trim().split("\n");
      const scoreText = str(fieldsOf(result.properties)?.["security-severity"]) ?? str(fieldsOf(rule?.properties)?.["security-severity"]);
      const score = scoreText === null ? null : Number(scoreText);
      const level =
        str(result.level) ?? str(fieldsOf(rule?.defaultConfiguration)?.level) ?? (kind === "informational" ? "note" : "warning");
      let severity = severityOf(level) ?? "medium";
      if (score !== null && Number.isFinite(score)) {
        severity = securitySeverity(score);
        risk = true;
      }
      const physical = fieldsOf(fieldsOf(listOf(result.locations)[0])?.physicalLocation);
      const region = fieldsOf(physical?.region);
      const help = str(fieldsOf(rule?.help)?.markdown) ?? str(fieldsOf(rule?.help)?.text) ?? str(fieldsOf(rule?.fullDescription)?.text);
      const restText = rest.join("\n").trim();
      const detail = [restText, help !== null && help.trim() !== titleLine!.trim() ? help.trim() : ""].filter((part) => part !== "").join("\n\n");
      const { fix, note } = sarifFix(result.fixes);
      findings.push(
        finding({
          severity,
          title: titleLine!.trim(),
          file: sarifUri(fieldsOf(physical?.artifactLocation), run),
          line: positiveInteger(region?.startLine),
          column: positiveInteger(region?.startColumn),
          endLine: positiveInteger(region?.endLine),
          endColumn: positiveInteger(region?.endColumn),
          detail: detail === "" ? null : detail,
          fix,
          fixNote: note,
          rule: ruleId ?? str(rule?.id),
          url: str(rule?.helpUri),
          snippet: str(fieldsOf(region?.snippet)?.text),
        }),
      );
    }
  }
  return { tool: tools.size === 0 ? "SARIF" : [...tools].join(", "), scale: risk ? "risk" : "lint", findings, ignored: 0 };
}

// ---------------------------------------------------------------------------
// tsc

/** `--pretty false`: `src/a.ts(12,5): error TS2322: …`; pretty without colours: `src/a.ts:12:5 - error TS2322: …`. */
const TSC_LOCATED = /^(.+?)(?:\((\d+),(\d+)\): | ?:(\d+):(\d+) - )(error|warning|message) (TS\d+): ?(.*)$/;
const TSC_GLOBAL = /^(error|warning|message) (TS\d+): ?(.*)$/;
/** Pretty output's code frame (`12   const a…`, `   ~~~~`) and its closing count. */
const TSC_NOISE = /^\s*\d+\s{2,}|^\s*~+\s*$|^Found \d+ errors?\b|^\s*$/;

/** Whether `text` reads as tsc's diagnostics (or tsc's empty output). */
function isTscText(text: string): boolean {
  if (text.trim() === "") return true;
  return plainLines(text).some((line) => TSC_LOCATED.test(line) || TSC_GLOBAL.test(line));
}

function fromTsc(text: string): FindingsReport {
  const findings: Finding[] = [];
  let current: { finding: Finding; detail: string[] } | null = null;
  const flush = () => {
    if (current === null) return;
    const detail = current.detail.join("\n").trimEnd();
    findings.push(detail === "" ? current.finding : { ...current.finding, detail, detailIsText: true });
    current = null;
  };
  for (const line of plainLines(text)) {
    const located = TSC_LOCATED.exec(line);
    const global = located === null ? TSC_GLOBAL.exec(line) : null;
    if (located !== null) {
      flush();
      current = {
        finding: finding({
          severity: severityOf(located[6]) ?? "high",
          title: located[8]!.trim(),
          file: reportPath(located[1]!.trim()),
          line: Number(located[2] ?? located[4]),
          column: Number(located[3] ?? located[5]),
          rule: located[7]!,
        }),
        detail: [],
      };
    } else if (global !== null) {
      flush();
      current = { finding: finding({ severity: severityOf(global[1]) ?? "high", title: global[3]!.trim(), rule: global[2]! }), detail: [] };
    } else if (current !== null && /^\s/.test(line) && !TSC_NOISE.test(line)) {
      // Message chains: each level indented two more spaces under the first line.
      current.detail.push(line.replace(/^ {2}/, ""));
    }
  }
  flush();
  return { tool: "tsc", scale: "lint", findings, ignored: 0 };
}

// ---------------------------------------------------------------------------
// Ruff

function isRuff(value: readonly Value[]): boolean {
  const first = fieldsOf(value[0]);
  return first !== null && typeof first.filename === "string" && fieldsOf(first.location) !== null && "code" in first;
}

function ruffPosition(value: Value | undefined): FilePosition | null {
  const location = fieldsOf(value);
  const line = positiveInteger(location?.row);
  const column = positiveInteger(location?.column);
  return line === null || column === null ? null : { line, column };
}

function fromRuff(items: readonly Value[]): FindingsReport {
  const findings: Finding[] = [];
  for (const raw of items) {
    const item = fieldsOf(raw);
    const title = str(item?.message);
    if (item === null || title === null) continue;
    const start = fieldsOf(item.location);
    const end = fieldsOf(item.end_location);
    const fixFields = fieldsOf(item.fix);
    const edits: TextEdit[] = [];
    for (const rawEdit of listOf(fixFields?.edits)) {
      const edit = fieldsOf(rawEdit);
      const from = ruffPosition(edit?.location);
      const to = ruffPosition(edit?.end_location);
      if (from !== null && to !== null) edits.push({ start: from, end: to, text: typeof edit?.content === "string" ? edit.content : "" });
    }
    const code = str(item.code);
    findings.push(
      finding({
        // Ruff reports every violation as an error; syntax errors have no code.
        severity: severityOf(item.severity) ?? "high",
        title: title.trim(),
        file: reportPath(str(item.filename)!),
        line: positiveInteger(start?.row),
        column: positiveInteger(start?.column),
        endLine: positiveInteger(end?.row),
        endColumn: positiveInteger(end?.column),
        fix: edits.length === 0 ? null : { kind: "edits", edits },
        fixNote: str(fixFields?.message),
        rule: code,
        url: str(item.url),
      }),
    );
  }
  return { tool: "Ruff", scale: "lint", findings, ignored: 0 };
}

// ---------------------------------------------------------------------------
// oxlint and Biome (`{diagnostics: [...]}`)

function fromOxlint(diagnostics: readonly Value[]): FindingsReport {
  const findings: Finding[] = [];
  for (const raw of diagnostics) {
    const item = fieldsOf(raw);
    const title = str(item?.message);
    if (item === null || title === null) continue;
    const span = fieldsOf(fieldsOf(listOf(item.labels)[0])?.span);
    const line = positiveInteger(span?.line);
    const column = positiveInteger(span?.column);
    const length = count(span?.length);
    const help = str(item.help);
    findings.push(
      finding({
        severity: severityOf(item.severity) ?? "medium",
        title: title.trim(),
        file: str(item.filename) === null ? null : reportPath(str(item.filename)!),
        line,
        column,
        endLine: line,
        endColumn: column !== null && length !== null && length > 0 ? column + length : null,
        detail: help,
        rule: str(item.code),
        url: str(item.url),
      }),
    );
  }
  return { tool: "oxlint", scale: "lint", findings, ignored: 0 };
}

function fromBiome(diagnostics: readonly Value[]): FindingsReport {
  const findings: Finding[] = [];
  for (const raw of diagnostics) {
    const item = fieldsOf(raw);
    const title = str(item?.description) ?? str(item?.message);
    if (item === null || title === null) continue;
    const location = fieldsOf(item.location);
    const path = str(location?.path) ?? str(fieldsOf(location?.path)?.file);
    const start = fieldsOf(location?.start);
    const end = fieldsOf(location?.end);
    const category = str(item.category);
    const rule = category?.startsWith("lint/") ? category.split("/").pop()! : category;
    findings.push(
      finding({
        severity: severityOf(item.severity) ?? "medium",
        title: title.trim(),
        file: path === null ? null : reportPath(path),
        line: positiveInteger(start?.line),
        column: positiveInteger(start?.column),
        endLine: positiveInteger(end?.line),
        endColumn: positiveInteger(end?.column),
        rule,
        // Biome's docs pages are the rule name in kebab case: noExplicitAny → no-explicit-any.
        url: category?.startsWith("lint/") ? `https://biomejs.dev/linter/rules/${rule!.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}/` : null,
      }),
    );
  }
  return { tool: "Biome", scale: "lint", findings, ignored: 0 };
}

// ---------------------------------------------------------------------------

/** The findings `value` describes: a list, or one of the tool outputs above. */
export function readFindings(value: Value | undefined): FindingsResult {
  if (typeof value === "string") {
    if (!isTscText(value)) return { ok: false, error: `${SHAPE_HINT}; this text has no "file(line,col): error TS…" lines` };
    return { ok: true, report: fromTsc(value) };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { ok: true, report: { tool: null, scale: "lint", findings: [], ignored: 0 } };
    if (isEslintResults(value)) return { ok: true, report: fromEslint(value, null) };
    if (isRuff(value)) return { ok: true, report: fromRuff(value) };
    const report = fromList(value);
    if (report.findings.length === 0) return { ok: false, error: "Findings items need a title (and a severity)" };
    return { ok: true, report };
  }
  const object = fieldsOf(value);
  if (object === null) return { ok: false, error: SHAPE_HINT };
  if (Array.isArray(object.runs)) return { ok: true, report: fromSarif(object) };
  if (isEslintResults(object.results) || (Array.isArray(object.results) && fieldsOf(object.metadata) !== null)) {
    return { ok: true, report: fromEslint(listOf(object.results), fieldsOf(fieldsOf(object.metadata)?.rulesMeta)) };
  }
  if (Array.isArray(object.diagnostics)) {
    const first = fieldsOf(object.diagnostics[0]);
    if (first !== null && ("category" in first || fieldsOf(first.location) !== null)) return { ok: true, report: fromBiome(object.diagnostics) };
    return { ok: true, report: fromOxlint(object.diagnostics) };
  }
  const review = reviewOf(object);
  for (const key of ["findings", "items", "issues"]) {
    const items = object[key];
    if (!Array.isArray(items)) continue;
    const read = readFindings(items);
    return !read.ok || review === null ? read : { ok: true, report: { ...read.report, review } };
  }
  // A verdict without findings: a clean review.
  if (review?.verdict != null) return { ok: true, report: { tool: null, scale: "lint", findings: [], ignored: 0, review } };
  return { ok: false, error: SHAPE_HINT };
}

// ---------------------------------------------------------------------------
// Reviews and their lifecycle

const VERDICT_WORDS: Readonly<Record<string, VerdictKind>> = {
  ship: "ship",
  "ship-it": "ship",
  approve: "ship",
  approved: "ship",
  pass: "ship",
  passed: "ship",
  lgtm: "ship",
  "fix-required": "fix-required",
  "fixes-required": "fix-required",
  "changes-requested": "fix-required",
  "request-changes": "fix-required",
  "needs-work": "fix-required",
  "needs-fixes": "fix-required",
  block: "blocked",
  blocked: "blocked",
  blocker: "blocked",
  "do-not-ship": "blocked",
  "no-ship": "blocked",
  reject: "blocked",
  rejected: "blocked",
  fail: "blocked",
  failed: "blocked",
};

/** Evidence and artifacts as one line each: strings, or objects naming a path, URL or text. */
function textList(value: Value | undefined): string[] {
  const items = typeof value === "string" ? [value] : listOf(value);
  return items.flatMap((item) => {
    const fields = fieldsOf(item);
    const text = fields === null ? str(item) : (str(fields.path) ?? str(fields.file) ?? str(fields.url) ?? str(fields.text) ?? str(fields.description) ?? str(fields.name));
    return text === null ? [] : [text.trim()];
  });
}

function reviewOf(object: Fields): Review | null {
  const verdictText = str(object.verdict)?.trim() ?? null;
  const subject = str(object.game) ?? str(object.subject) ?? str(object.slice) ?? str(object.component) ?? str(object.target);
  const evidence = textList(object.evidence);
  const artifacts = textList(object.artifacts);
  if (verdictText === null && subject === null && evidence.length === 0 && artifacts.length === 0) return null;
  const word = verdictText?.toLowerCase().replace(/[\s_]+/g, "-");
  return {
    subject: subject?.trim() ?? null,
    verdict: verdictText === null ? null : { kind: VERDICT_WORDS[word!] ?? "other", text: verdictText },
    evidence,
    artifacts,
  };
}

/** Whether a finding still needs a fix: open (or without a status) or deferred to another owner. */
export function needsFix(item: Finding): boolean {
  return item.status === null || item.status === "open" || item.status === "deferred";
}

/** Settled: the fix confirmed, the finding rejected, or not to be fixed. A fix only its owner reports is not. */
export function isResolved(item: Finding): boolean {
  return item.status === "confirmed" || item.status === "rejected" || item.status === "wontfix";
}

/** Whether any finding carries a status: only then does the lifecycle show. */
export function hasLifecycle(findings: readonly Finding[]): boolean {
  return findings.some((item) => item.status !== null);
}

export interface StatusCount {
  readonly status: FindingStatus;
  readonly count: number;
  /** `4 open`, `2 fixed, awaiting confirmation`, `1 deferred to shared shell`. */
  readonly text: string;
}

/** The findings per status, in STATUSES order, for the statuses present; empty without a lifecycle. */
export function statusCounts(findings: readonly Finding[]): StatusCount[] {
  if (!hasLifecycle(findings)) return [];
  return STATUSES.flatMap((status) => {
    const items = findings.filter((item) => (item.status ?? "open") === status);
    if (items.length === 0) return [];
    const n = items.length;
    const owners = new Set(items.map((item) => item.owner));
    const owner = owners.size === 1 ? [...owners][0]! : null;
    const words: Record<FindingStatus, string> = {
      open: "open",
      deferred: owner === null ? "deferred" : `deferred to ${owner}`,
      fixed: "fixed, awaiting confirmation",
      confirmed: "confirmed",
      rejected: "rejected",
      wontfix: "won't fix",
    };
    return [{ status, count: n, text: `${n} ${words[status]}` }];
  });
}

export type VerdictTone = "good" | "warn" | "bad";

/**
 * The review's verdict with what is still open: `Fix required: 2 P1, 1 P2
 * open`, `Ship: 5 P2 open`, `Fix required: nothing open · 2 awaiting
 * confirmation`. Its tone follows what is open, not the verdict's word: a
 * "ship" with an open P1 reads bad. Null without a verdict.
 */
export function verdictHeadline(report: FindingsReport): { text: string; tone: VerdictTone } | null {
  const verdict = report.review?.verdict;
  if (verdict == null) return null;
  const labels: Record<VerdictKind, string> = { ship: "Ship", "fix-required": "Fix required", blocked: "Blocked", other: "" };
  const label = labels[verdict.kind] || verdict.text.replace(/[-_]+/g, " ").replace(/^./, (first) => first.toUpperCase());
  const open = report.findings.filter(needsFix);
  const counts = countSeverities(open);
  const awaiting = report.findings.filter((item) => item.status === "fixed").length;
  const openText =
    open.length === 0
      ? "nothing open"
      : `${SEVERITIES.filter((severity) => counts[severity] > 0)
          .map((severity) => severityCount(severity, report.scale, counts[severity]))
          .join(", ")} open`;
  const text = `${label}: ${openText}${awaiting === 0 ? "" : ` · ${awaiting} awaiting confirmation`}`;
  const tone: VerdictTone = counts.critical + counts.high > 0 ? "bad" : open.length + awaiting > 0 ? "warn" : "good";
  return { text, tone };
}

/** Where one finding stands, in a sentence: `Fixed by Coil owner in a1b2c3d; not yet confirmed by the reviewer · round 2`. */
export function statusSentence(item: Finding): string {
  const revision = item.revision === null ? "" : ` in ${item.revision}`;
  const checker = item.by ?? item.owner;
  const sentences: Record<FindingStatus, string> = {
    open: item.owner === null ? "Open" : `Open, owned by ${item.owner}`,
    deferred: `Deferred to ${item.owner ?? "another owner"}`,
    fixed: `Fixed by ${item.owner ?? "its owner"}${revision}; not yet confirmed by the reviewer`,
    confirmed: `Fix confirmed by ${item.by ?? "the reviewer"}${revision}`,
    rejected: `Rejected by ${checker ?? "its owner"}`,
    wontfix: `Won't fix${checker === null ? "" : ` (${checker})`}`,
  };
  const round = item.round === null ? "" : ` · ${/^\d+$/.test(item.round) ? `round ${item.round}` : item.round}`;
  return `${sentences[item.status ?? "open"]}${round}`;
}

// ---------------------------------------------------------------------------
// Order and groups

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** What needs a fix first, then fixes awaiting confirmation, then settled findings. */
function lifecycleRank(item: Finding): number {
  if (needsFix(item)) return 0;
  return isResolved(item) ? 2 : 1;
}

/** Unresolved first (where findings carry statuses), then most severe, then by file and position; the given order breaks ties. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        lifecycleRank(a.item) - lifecycleRank(b.item) ||
        severityRank(a.item.severity) - severityRank(b.item.severity) ||
        (a.item.file ?? "\uffff").localeCompare(b.item.file ?? "\uffff") ||
        (a.item.line ?? 0) - (b.item.line ?? 0) ||
        (a.item.column ?? 0) - (b.item.column ?? 0) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

export type SeverityCounts = Readonly<Record<Severity, number>>;

export function countSeverities(findings: readonly Finding[]): SeverityCounts {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity]++;
  return counts;
}

export interface FindingGroup {
  /** The file, area or severity the group gathers; `file` and `area` null for findings without one. */
  readonly key: string;
  readonly file: string | null;
  /** Set when grouped by area (a review's area, a rule's category). */
  readonly area: string | null;
  readonly severity: Severity | null;
  readonly findings: readonly Finding[];
  readonly counts: SeverityCounts;
}

/** Groups by `keyOf` ("" for none): the most severe groups first (then the most findings), the keyless group last. */
function groupByKey(findings: readonly Finding[], keyOf: (item: Finding) => string, area: boolean): FindingGroup[] {
  const groups = new Map<string, Finding[]>();
  for (const item of findings) {
    const key = keyOf(item);
    let group = groups.get(key);
    if (group === undefined) groups.set(key, (group = []));
    group.push(item);
  }
  return [...groups]
    .map(([key, items]) => {
      const sorted = sortFindings(items);
      const name = key === "" ? null : key;
      return { key, file: area ? null : name, area: area ? name : null, severity: null, findings: sorted, counts: countSeverities(sorted) };
    })
    .sort((a, b) => {
      for (const severity of SEVERITIES) {
        const difference = b.counts[severity] - a.counts[severity];
        if (difference !== 0) return difference;
      }
      if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
      return a.key.localeCompare(b.key);
    });
}

/** By file: the files with the most severe findings first (then the most findings), each file's findings most severe first, then by position. */
export function groupByFile(findings: readonly Finding[]): FindingGroup[] {
  return groupByKey(findings, (item) => item.file ?? "", false);
}

/** By area (a review's `area`, else the rule), ordered like groupByFile: for reviews whose findings name no file. */
export function groupByArea(findings: readonly Finding[]): FindingGroup[] {
  return groupByKey(findings, (item) => item.rule ?? "", true);
}

/** By severity, most severe first, each by file and position. */
export function groupBySeverity(findings: readonly Finding[]): FindingGroup[] {
  const sorted = sortFindings(findings);
  return SEVERITIES.flatMap((severity) => {
    const items = sorted.filter((item) => item.severity === severity);
    return items.length === 0 ? [] : [{ key: severity, file: null, area: null, severity, findings: items, counts: countSeverities(items) }];
  });
}

// ---------------------------------------------------------------------------
// Messages

/** `data/src/a.ts:12`, `data/src/a.ts` or "" without a file. */
export function findingLocation(item: Finding, path: string | null = item.file): string {
  if (path === null) return "";
  return item.line === null ? path : `${path}:${item.line}`;
}

/** What "Fix this" sends: `Fix <title> (<rule>) at <file>:<line>`, saying so when the finding was deferred to another owner. */
export function fixThisMessage(item: Finding, path: string | null = item.file): string {
  const title = item.title.replace(/\.\s*$/, "");
  const rule = item.rule === null ? "" : ` (${item.rule})`;
  const where = findingLocation(item, path);
  const deferred = item.status === "deferred" ? ` — deferred to ${item.owner ?? "another owner"}` : "";
  return `Fix ${title}${rule}${where === "" ? "" : ` at ${where}`}${deferred}`;
}

/** Findings listed in a "Fix all" message before "… and N more". */
const FIX_ALL_LINES = 40;

/**
 * What "Fix all N" sends: the count per severity, then one line per finding
 * (most severe first), cut after FIX_ALL_LINES. Findings with a status are
 * called open, and `subject` names the review they come from.
 */
export function fixAllMessage(
  findings: readonly Finding[],
  scale: SeverityScale,
  path: (item: Finding) => string | null = (item) => item.file,
  subject: string | null = null,
): string {
  const sorted = sortFindings(findings);
  const counts = countSeverities(sorted);
  const breakdown = SEVERITIES.filter((severity) => counts[severity] > 0)
    .map((severity) => severityCount(severity, scale, counts[severity]))
    .join(", ");
  const lines = sorted.slice(0, FIX_ALL_LINES).map((item) => {
    const where = findingLocation(item, path(item));
    const rule = item.rule === null ? "" : ` (${item.rule})`;
    const deferred = item.status === "deferred" ? ` — deferred to ${item.owner ?? "another owner"}` : "";
    return `- ${where === "" ? "" : `${where} `}${severityLabel(item.severity, scale)}: ${item.title}${rule}${deferred}`;
  });
  const more = sorted.length - lines.length;
  const open = hasLifecycle(sorted) ? "open " : "";
  const source = subject === null ? "" : ` from the ${subject} review`;
  return [
    `Fix all ${sorted.length} ${open}${sorted.length === 1 ? "finding" : "findings"}${source} (${breakdown}):`,
    ...lines,
    ...(more > 0 ? [`… and ${more} more`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fixes as patches

/** Character offset of each line's start. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function toOffset(position: FilePosition, starts: readonly number[], length: number): number | null {
  if ("offset" in position) return position.offset <= length ? position.offset : null;
  if (position.line === starts.length + 1 && position.column === 1) return length;
  const start = starts[position.line - 1];
  if (start === undefined) return null;
  const next = starts[position.line] ?? length + 1;
  // Columns past the line's end clamp to it (before its newline).
  return Math.min(start + position.column - 1, next - 1, length);
}

/** Lines of context around each change in a fix's patch. */
const PATCH_CONTEXT = 2;

/**
 * A unified patch for `edits` applied to `source` (the file at `path`), one
 * hunk per run of nearby changes; null when an edit falls outside the file
 * or edits overlap.
 */
export function editsPatch(source: string, path: string, edits: readonly TextEdit[]): string | null {
  const starts = lineStarts(source);
  const resolved: { start: number; end: number; text: string }[] = [];
  for (const edit of edits) {
    const start = toOffset(edit.start, starts, source.length);
    const end = toOffset(edit.end, starts, source.length);
    if (start === null || end === null || end < start) return null;
    resolved.push({ start, end, text: edit.text });
  }
  if (resolved.length === 0) return null;
  resolved.sort((a, b) => a.start - b.start);
  for (let index = 1; index < resolved.length; index++) if (resolved[index]!.start < resolved[index - 1]!.end) return null;

  const lineOf = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low; // 0-based
  };
  const oldLines = source.split("\n");
  // Runs of edits whose touched lines are within 2 × context of each other share a hunk.
  const clusters: { first: number; last: number; edits: typeof resolved }[] = [];
  for (const edit of resolved) {
    const first = lineOf(edit.start);
    const last = lineOf(Math.max(edit.start, edit.end - (edit.end > edit.start && source[edit.end - 1] === "\n" ? 1 : 0)));
    const previous = clusters.at(-1);
    if (previous !== undefined && first - previous.last <= PATCH_CONTEXT * 2) {
      previous.last = Math.max(previous.last, last);
      previous.edits.push(edit);
    } else clusters.push({ first, last, edits: [edit] });
  }
  const hunks: string[] = [];
  let shift = 0;
  for (const cluster of clusters) {
    const from = Math.max(0, cluster.first - PATCH_CONTEXT);
    const to = Math.min(oldLines.length - 1, cluster.last + PATCH_CONTEXT);
    const regionStart = starts[cluster.first]!;
    const regionEnd = cluster.last + 1 < starts.length ? starts[cluster.last + 1]! - 1 : source.length;
    let changed = "";
    let cursor = regionStart;
    for (const edit of cluster.edits) {
      changed += source.slice(cursor, edit.start) + edit.text;
      cursor = Math.max(cursor, edit.end);
    }
    changed += source.slice(cursor, Math.max(cursor, regionEnd));
    const removed = oldLines.slice(cluster.first, cluster.last + 1);
    const added = changed === "" && removed.length > 0 && cluster.edits.every((edit) => edit.text === "") ? [] : changed.split("\n");
    const before = oldLines.slice(from, cluster.first);
    const after = oldLines.slice(cluster.last + 1, to + 1);
    const oldCount = before.length + removed.length + after.length;
    const newCount = before.length + added.length + after.length;
    hunks.push(
      [
        `@@ -${from + 1},${oldCount} +${from + 1 + shift},${newCount} @@`,
        ...before.map((line) => ` ${line}`),
        ...removed.map((line) => `-${line}`),
        ...added.map((line) => `+${line}`),
        ...after.map((line) => ` ${line}`),
      ].join("\n"),
    );
    shift += added.length - removed.length;
  }
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
}
