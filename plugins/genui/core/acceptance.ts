// Acceptance: is it really done? Reads acceptance criteria as agents write
// them (a list with one status each, or a matrix of conditions per
// criterion), a gate or owner result through `Load`, or a flat CSV, into one
// report, and says what is proven, by whom, and what is still open. Pure: the
// UI (ui/components/Acceptance.tsx) and the markdown fallback both read it.
//
// Honesty rules: an unknown or missing result is "not tested", never passed;
// what an owner reported is "claimed", never passed; "done" is a claim.
import { isPlainObject } from "./evaluate";
import type { Value } from "./types";

export type AcceptanceRead = { readonly ok: true; readonly report: AcceptanceReport } | { readonly ok: false; readonly error: string };

export type AcceptanceStatus = "passed" | "failed" | "blocked" | "untested" | "claimed" | "skipped";

/** Worst first: how a criterion reads when its conditions disagree, and the order counts are listed in. */
export const STATUS_ORDER: readonly AcceptanceStatus[] = ["failed", "blocked", "untested", "skipped", "claimed", "passed"];

/** Evidence a check points at: a file (at a line), a web page, an image, or what a tool printed. */
export type Evidence =
  | { readonly kind: "file"; readonly path: string; readonly line: number | null; readonly endLine: number | null; readonly label: string | null }
  | { readonly kind: "url"; readonly url: string; readonly label: string | null }
  | { readonly kind: "image"; readonly src: string; readonly label: string | null }
  | { readonly kind: "text"; readonly text: string; readonly label: string | null };

/** One result: a matrix cell, or a single-status criterion's own result. */
export interface Check {
  readonly status: AcceptanceStatus;
  /** The status as written when it says more than the canonical word ("not met", "pending", "no match"), or text that is no known status; null otherwise. */
  readonly given: string | null;
  /** False when `given` is no status this knows (read as not tested). */
  readonly known: boolean;
  /** Written as n/a: not counted as a gap, said as "not applicable". */
  readonly notApplicable: boolean;
  /** False when nothing was written for it (a matrix cell with no entry): "no result recorded". */
  readonly recorded: boolean;
  /** What it waits on from the user ("plug in the iPhone"); "" when the status only said so; null when it doesn't. */
  readonly needs: string | null;
  readonly note: string | null;
  readonly by: string | null;
  readonly method: string | null;
  readonly run: string | null;
  readonly at: string | null;
  readonly evidence: readonly Evidence[];
}

export interface Criterion {
  /** Position in the report, for keys. */
  readonly index: number;
  readonly name: string;
  readonly detail: string | null;
  readonly required: boolean;
  /**
   * The criterion's own result. In the matrix form its status is the worst of
   * its cells (n/a cells aside) and its note, evidence and `by` are the
   * row-level ones written on the criterion.
   */
  readonly own: Check;
  /** One per shown column in the matrix form; null in the single-status form. */
  readonly cells: readonly Check[] | null;
  /** A status written on a matrix row that its cells contradict ("passed" with a failed cell); null otherwise. */
  readonly stated: AcceptanceStatus | null;
}

export interface AcceptanceReport {
  readonly title: string | null;
  /** The condition columns shown, in order; empty in the single-status form. */
  readonly columns: readonly string[];
  /** Columns the data has that `columns` left out. */
  readonly hiddenColumns: number;
  readonly criteria: readonly Criterion[];
  /** Items left out because they have no name (a half-written item while the reply streams). */
  readonly unnamed: number;
  /** What the owner's result said about itself: `complete: true|false`, a reviewer's `verdict`. */
  readonly ownerComplete: boolean | null;
  readonly statedVerdict: string | null;
  /** Limitations an owner result lists. */
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// Reading values

type Field = Value | undefined;
type Fields = { readonly [key: string]: Value };

function record(value: Field): Fields | null {
  // Narrowing keeps structurally compatible Action shapes; widen to read by key.
  return value !== undefined && isPlainObject(value) ? value : null;
}

function str(value: Field): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The first of `keys` that holds a usable string. */
function pick(item: Fields, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = str(item[key]);
    if (value !== null) return value;
  }
  return null;
}

function strings(value: Field): string[] {
  const items: readonly Value[] = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return items.flatMap((item) => {
    const text = str(item) ?? pick(record(item) ?? {}, ["text", "title", "name", "issue", "detail", "message"]);
    return text === null ? [] : [text];
  });
}

// ---------------------------------------------------------------------------
// Statuses

type StatusWord = {
  readonly status: AcceptanceStatus;
  /** A spelling that says nothing beyond the status ("pass", "FAILED"); others ("not met", "pending") are kept to show. */
  readonly plain?: boolean;
  readonly notApplicable?: boolean;
  readonly needsYou?: boolean;
  readonly owner?: boolean;
};

/** Every spelling read, by its key (lowercase, runs of anything but letters and digits as one space; symbols as written). */
const STATUS_WORDS: Readonly<Record<string, StatusWord>> = (() => {
  const table: Record<string, StatusWord> = {};
  const add = (word: StatusWord, ...keys: string[]) => keys.forEach((key) => (table[key] = word));
  add({ status: "passed", plain: true }, "pass", "passed", "passes", "passing", "ok", "success", "succeeded", "successful", "green", "yes", "y", "✓", "✔", "✔️", "✅", "true");
  add({ status: "passed", plain: true }, "met", "verified", "accepted", "proven", "confirmed");
  add({ status: "failed", plain: true }, "fail", "failed", "fails", "failing", "failure", "red", "no", "n", "✗", "✘", "❌", "false");
  add({ status: "failed" }, "not met", "unmet", "error", "errored", "broken", "regressed", "rejected");
  add({ status: "blocked", plain: true }, "blocked");
  add({ status: "blocked" }, "blocker", "capture blocked", "captureblocked", "on hold", "waiting", "stuck");
  add({ status: "blocked", needsYou: true, plain: true }, "needs you", "needs user", "needs input", "needs decision", "needs approval", "waiting on you", "waiting on user", "waiting for you", "waiting for user", "awaiting user", "awaiting input", "awaiting you");
  add({ status: "untested", plain: true }, "untested", "not tested");
  add({ status: "untested" }, "not exercised", "unexercised", "not run", "pending", "unknown", "todo", "to do", "not started", "open", "missing", "no result", "unmeasured", "not measured", "?");
  add({ status: "untested", notApplicable: true, plain: true }, "n a", "na", "not applicable", "inapplicable", "—", "-");
  add({ status: "claimed", plain: true }, "claimed");
  add({ status: "claimed" }, "reported", "unverified", "not verified", "self reported", "agent reported", "done", "complete", "completed", "implemented", "fixed", "ready", "says done");
  add({ status: "claimed", owner: true, plain: true }, "owner reported", "owner says", "owner says done", "owner claimed", "owner verified");
  add({ status: "skipped", plain: true }, "skipped", "skip", "skips");
  add({ status: "skipped" }, "no match", "no matches", "zero tests", "0 tests", "no tests", "ignored", "excluded");
  return table;
})();

/** A status as written: the canonical word, or null for text this doesn't know. */
export function statusWord(value: Field): StatusWord | null {
  if (value === true || value === false) return { status: value ? "passed" : "failed", plain: true };
  const raw = str(value);
  if (raw === null) return null;
  const key = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (Object.hasOwn(STATUS_WORDS, key)) return STATUS_WORDS[key]!;
  return Object.hasOwn(STATUS_WORDS, raw) ? STATUS_WORDS[raw]! : null;
}

// ---------------------------------------------------------------------------
// Evidence

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

/** `path:12`, `path:12:3`, `path:12-20`, `path#L12`, `path#L12-L20` split into the path and its lines. */
function fileLocation(raw: string): { path: string; line: number | null; endLine: number | null } {
  const hash = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(raw);
  if (hash !== null) return { path: hash[1]!, line: Number(hash[2]), endLine: hash[3] === undefined ? null : Number(hash[3]) };
  const colon = /^(.*?\.[A-Za-z][\w]{0,9}):(\d+)(?:(?::\d+)|(?:-(\d+)))?$/.exec(raw);
  if (colon !== null) return { path: colon[1]!, line: Number(colon[2]), endLine: colon[3] === undefined ? null : Number(colon[3]) };
  return { path: raw, line: null, endLine: null };
}

/** Whether a written string names a file: one token with a path prefix or a file extension. */
function looksLikePath(raw: string): boolean {
  if (/\s/.test(raw.replace(/\\ /g, ""))) return false;
  if (/^(\/|\.{1,2}\/|~\/|\$[A-Z_]+|[a-z]:[\\/])/i.test(raw)) return true;
  const location = fileLocation(raw).path;
  return /\.[A-Za-z][\w]{0,9}$/.test(location) && /[A-Za-z]/.test(location.replace(/\.[^.]*$/, ""));
}

/** One piece of evidence from a string: an http(s) link, an image or a file by its shape, else text. */
function evidenceFromString(raw: string, label: string | null): Evidence {
  if (/^https?:\/\//i.test(raw)) {
    let path = raw;
    try {
      path = new URL(raw).pathname;
    } catch {
      return { kind: "text", text: raw, label };
    }
    return /^https:/i.test(raw) && IMAGE_EXTENSION.test(path) ? { kind: "image", src: raw, label } : { kind: "url", url: raw, label };
  }
  if (looksLikePath(raw)) {
    const location = fileLocation(raw);
    if (location.line === null && IMAGE_EXTENSION.test(location.path)) return { kind: "image", src: location.path, label };
    return { kind: "file", path: location.path, line: location.line, endLine: location.endLine !== null && location.line !== null && location.endLine >= location.line ? location.endLine : null, label };
  }
  return { kind: "text", text: raw, label };
}

/** Evidence as written: a string, `{path, line?}`, `{url}`, `{image | src}`, `{text}` (each with an optional label), or a list of them. */
export function readEvidence(value: Field): Evidence[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item: Value) => readEvidence(item));
  const one = str(value);
  if (one !== null) return [evidenceFromString(one, null)];
  const item = record(value);
  if (item === null) return [];
  const label = pick(item, ["label", "title", "name", "caption", "kind"]);
  const url = pick(item, ["url", "href", "link"]);
  if (url !== null) return [evidenceFromString(url, label)];
  const image = pick(item, ["image", "src", "screenshot"]);
  if (image !== null) return [{ kind: "image", src: image, label }];
  const path = pick(item, ["path", "file", "artifact"]);
  if (path !== null) {
    const location = fileLocation(path);
    const line = typeof item.line === "number" && Number.isSafeInteger(item.line) && item.line > 0 ? item.line : location.line;
    const end = typeof item.endLine === "number" && Number.isSafeInteger(item.endLine) ? item.endLine : location.endLine;
    if (line === null && IMAGE_EXTENSION.test(location.path)) return [{ kind: "image", src: location.path, label }];
    return [{ kind: "file", path: location.path, line, endLine: end !== null && line !== null && end >= line ? end : null, label }];
  }
  const text = pick(item, ["text", "output", "excerpt", "value", "summary"]);
  return text === null ? [] : [{ kind: "text", text, label }];
}

// ---------------------------------------------------------------------------
// Checks

const NAME_KEYS = ["name", "criterion", "title", "requirement", "check", "label", "item"];
const STATUS_KEYS = ["status", "state", "result", "outcome"];
const NOTE_KEYS = ["note", "reason", "why", "notes", "comment", "message"];
const BY_KEYS = ["by", "checkedBy", "verifiedBy", "checker", "reviewer", "verifier"];
const RUN_KEYS = ["run", "revision", "rev", "sha", "commit", "build", "job"];
const AT_KEYS = ["at", "time", "checkedAt", "date", "timestamp"];
const EVIDENCE_KEYS = ["evidence", "proof", "artifact", "artifacts", "receipt", "receipts", "screenshot"];
const CELL_COLUMN_KEYS = ["column", "condition", "platform", "device", "viewport", "env", "environment", "name"];

/** Fields of a criterion that aren't conditions when a flat row's other keys are read as columns. */
const ROW_KEYS: Readonly<Record<string, true>> = Object.fromEntries(
  [
    ...NAME_KEYS,
    ...STATUS_KEYS,
    ...NOTE_KEYS,
    ...BY_KEYS,
    ...RUN_KEYS,
    ...AT_KEYS,
    ...EVIDENCE_KEYS,
    "detail",
    "description",
    "required",
    "optional",
    "needs",
    "method",
    "id",
    "key",
    "cells",
    "owner",
    "area",
  ].map((key) => [key, true]),
);

const NO_RESULT: Check = {
  status: "untested",
  given: null,
  known: true,
  notApplicable: false,
  recorded: false,
  needs: null,
  note: null,
  by: null,
  method: null,
  run: null,
  at: null,
  evidence: [],
};

/** A check from a status word or `{status, note?, evidence?, by?, method?, run?, at?, needs?}`; `fallback` when no status is written. */
function readCheck(value: Field, fallback: AcceptanceStatus | null, owner: string | null = null): Check {
  if (value === undefined || value === null) return NO_RESULT;
  const item = record(value);
  const statusValue = item === null ? value : STATUS_KEYS.map((key) => item[key]).find((field) => field !== undefined && field !== null);
  const word = statusWord(statusValue);
  const written = typeof statusValue === "boolean" ? null : str(statusValue);
  const needsField = item === null ? null : str(item.needs);
  let status: AcceptanceStatus;
  let notApplicable = false;
  let needs: string | null = null;
  let given: string | null = null;
  let known = true;
  if (word !== null) {
    status = word.status;
    notApplicable = word.notApplicable === true;
    if (word.needsYou === true) needs = "";
    if (written !== null && word.plain !== true) given = written;
  } else if (written !== null) {
    status = "untested";
    given = written;
    known = false;
  } else if (needsField !== null) {
    status = "blocked";
  } else if (fallback !== null) {
    status = fallback;
  } else {
    status = "untested";
  }
  if (needsField !== null && status !== "passed" && !notApplicable) needs = needsField;
  const fields = item ?? {};
  const by = pick(fields, BY_KEYS) ?? (status === "claimed" ? (owner ?? (word?.owner === true ? "owner" : null)) : null);
  const note = pick(fields, NOTE_KEYS);
  const method = pick(fields, ["method", "how", "tool", "via"]);
  const run = pick(fields, RUN_KEYS);
  const at = pick(fields, AT_KEYS);
  const evidence = EVIDENCE_KEYS.flatMap((key) => readEvidence(fields[key]));
  return {
    status,
    given,
    known,
    notApplicable,
    // A bare name, or a row with nothing but its name, records no result.
    recorded: word !== null || written !== null || needsField !== null || fallback !== null || [note, by, method, run, at].some((part) => part !== null) || evidence.length > 0,
    needs,
    note,
    by,
    method,
    run,
    at,
    evidence,
  };
}

/** The worst status of `checks` (n/a ones aside); null when every check is n/a or there are none. */
export function worstStatus(checks: readonly Check[]): AcceptanceStatus | null {
  let worst: number | null = null;
  for (const check of checks) {
    if (check.notApplicable) continue;
    const rank = STATUS_ORDER.indexOf(check.status);
    if (worst === null || rank < worst) worst = rank;
  }
  return worst === null ? null : STATUS_ORDER[worst]!;
}

// ---------------------------------------------------------------------------
// The report

interface Source {
  readonly items: readonly Value[];
  readonly columns: Field;
  readonly title: string | null;
  readonly ownerComplete: boolean | null;
  readonly statedVerdict: string | null;
  readonly limitations: readonly string[];
  /** Status for items that write none: an owner's contract is what the owner claims. */
  readonly fallback: AcceptanceStatus | null;
  readonly owner: string | null;
}

const LIST_KEYS = ["criteria", "rows", "items", "checks", "acceptance", "requirements", "results", "gates"];

/** A `{name: status | cell}` map as criteria; null when any value is neither. */
function mapItems(value: Fields): Value[] | null {
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const items: Value[] = [];
  for (const [name, entry] of entries) {
    const item = record(entry);
    if (item !== null) {
      const isCheck = STATUS_KEYS.some((key) => item[key] !== undefined) || item.cells !== undefined || item.needs !== undefined;
      if (isCheck) {
        items.push({ ...item, name });
        continue;
      }
      // A matrix row, `{column: status | {status}}`, when every value is one.
      const isRow = Object.values(item).every((cell) => statusWord(cell) !== null || STATUS_KEYS.some((key) => record(cell)?.[key] !== undefined));
      if (!isRow) return null;
      items.push({ name, cells: item });
    } else if (typeof entry === "string" || typeof entry === "boolean") {
      if (statusWord(entry) === null) return null;
      items.push({ name, status: entry });
    } else return null;
  }
  return items;
}

/** Where the criteria are in what was given: a list, a wrapper object (`{criteria}`, `{rows}`, a gate's `{matrix}`, an owner's `{contract, blockers}`), or a `{name: status}` map. */
function findSource(value: Field): Source | string {
  const base = { columns: undefined, title: null, ownerComplete: null, statedVerdict: null, limitations: [], fallback: null, owner: null };
  if (Array.isArray(value)) return { ...base, items: value };
  const object = record(value);
  if (object === null) return "Acceptance needs a list of criteria [{name, status}] or [{name, cells: {column: status}}]";
  const title = pick(object, ["title", "subject", "feature", "game", "name", "goal"]);
  const ownerComplete = typeof object.complete === "boolean" ? object.complete : null;
  const statedVerdict = pick(object, ["verdict", "decision"]);
  const limitations = strings(object.limitations ?? object.caveats);
  const wrapper = { ...base, columns: object.columns, title, ownerComplete, statedVerdict, limitations };
  const blockers = strings(object.blockers).map((text): Value => ({ name: text, status: "blocked" }));
  for (const key of LIST_KEYS) {
    const items = object[key];
    if (Array.isArray(items)) return { ...wrapper, items: [...items, ...blockers] };
    const map = record(items);
    const mapped = map === null ? null : mapItems(map);
    if (mapped !== null) return { ...wrapper, items: [...mapped, ...blockers] };
  }
  const matrix = record(object.matrix);
  if (matrix !== null) {
    const mapped = mapItems(matrix);
    if (mapped !== null) return { ...wrapper, items: [...mapped, ...blockers] };
  }
  if (Array.isArray(object.matrix)) return { ...wrapper, items: [...object.matrix, ...blockers] };
  if (Array.isArray(object.contract)) {
    const owner = pick(object, ["owner", "by", "author"]) ?? "owner";
    return { ...wrapper, items: [...object.contract, ...blockers], fallback: "claimed", owner };
  }
  if (blockers.length > 0) return { ...wrapper, items: blockers };
  const mapped = mapItems(object);
  if (mapped !== null) return { ...base, items: mapped };
  return "Acceptance needs a list of criteria [{name, status}], {criteria: [...]}, a gate {matrix} or an owner result {contract}";
}

function readColumns(value: Field): string[] | null {
  if (!Array.isArray(value)) return null;
  const columns: string[] = [];
  for (const item of value as readonly Value[]) {
    const name = str(item) ?? pick(record(item) ?? {}, ["name", "key", "label", "title"]);
    if (name !== null && !columns.includes(name)) columns.push(name);
  }
  return columns;
}

/** A matrix row's cells by column: `{column: cell}`, or a list of cells named by a `column`-like key or by position. */
function rowCells(item: Fields, given: readonly string[] | null): Map<string, Value> | null {
  const cells = item.cells ?? item.conditions;
  const object = record(cells);
  if (object !== null) return new Map(Object.entries(object).map(([key, cell]) => [key.trim(), cell]));
  if (Array.isArray(cells)) {
    const map = new Map<string, Value>();
    (cells as readonly Value[]).forEach((cell, position) => {
      const named = pick(record(cell) ?? {}, CELL_COLUMN_KEYS);
      map.set(named ?? given?.[position] ?? `#${position + 1}`, cell);
    });
    return map;
  }
  return null;
}

/** Keys of flat rows (a CSV, `{name, iPhone: "pass", Mac: "fail"}`) that hold statuses: the columns when nothing else names them. */
function flatColumns(items: readonly Fields[]): string[] {
  const columns: string[] = [];
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (Object.hasOwn(ROW_KEYS, key) || columns.includes(key)) continue;
      const cell = record(value);
      if (statusWord(value) !== null || (cell !== null && STATUS_KEYS.some((status) => cell[status] !== undefined))) columns.push(key);
    }
  }
  return columns;
}

/**
 * Criteria from what an agent wrote or a tool saved, with `columns` (the
 * component's param) ordering and limiting the condition columns. Without
 * columns and without cells each criterion has one status.
 */
export function readAcceptance(value: Field, columnsParam?: Field): AcceptanceRead {
  const source = findSource(value);
  if (typeof source === "string") return { ok: false, error: source };
  const rows: Fields[] = [];
  let unnamed = 0;
  for (const item of source.items) {
    const fields = record(item) ?? (str(item) !== null ? { name: str(item)! } : null);
    if (fields === null || pick(fields, NAME_KEYS) === null) {
      unnamed++;
      continue;
    }
    rows.push(fields);
  }
  const given = readColumns(columnsParam) ?? readColumns(source.columns);
  const cellMaps = rows.map((row) => rowCells(row, given));
  const hasCells = cellMaps.some((cells) => cells !== null);
  const hasStatus = rows.some((row) => STATUS_KEYS.some((key) => row[key] !== undefined) || row.needs !== undefined);
  // Columns the data itself names, in first-seen order.
  let dataColumns: string[] = [];
  if (hasCells) {
    for (const cells of cellMaps) for (const key of cells?.keys() ?? []) if (!dataColumns.includes(key)) dataColumns.push(key);
  } else if (given !== null || !hasStatus) {
    dataColumns = flatColumns(rows);
  }
  const flat = !hasCells && (given !== null ? given.length > 0 : dataColumns.length > 0);
  const columns = hasCells || flat ? (given ?? dataColumns) : [];
  const hiddenColumns = given === null ? 0 : dataColumns.filter((column) => !given.includes(column)).length;
  const matrix = columns.length > 0;

  const criteria = rows.map((row, index): Criterion => {
    const name = pick(row, NAME_KEYS)!;
    const optional = row.optional === true || row.required === false || str(row.required)?.toLowerCase() === "optional";
    const detail = pick(row, ["detail", "description"]);
    if (!matrix) {
      return { index, name, detail, required: !optional, own: readCheck(row, source.fallback, source.owner), cells: null, stated: null };
    }
    const cells = cellMaps[index];
    const checks = columns.map((column) => readCheck(cells === null || cells === undefined ? (flat ? row[column] : undefined) : cells.get(column), source.fallback, source.owner));
    const ownCheck = readCheck({ ...row, status: null }, null, source.owner);
    const worst = worstStatus(checks);
    const statedWord = STATUS_KEYS.map((key) => statusWord(row[key])).find((word) => word !== null) ?? null;
    const status = worst ?? "untested";
    const stated = statedWord !== null && !statedWord.notApplicable && worst !== null && statedWord.status !== worst ? statedWord.status : null;
    const own: Check = {
      ...ownCheck,
      status,
      given: null,
      known: true,
      notApplicable: worst === null && checks.length > 0,
      recorded: checks.some((check) => check.recorded),
      needs: ownCheck.needs,
    };
    return { index, name, detail, required: !optional, own, cells: checks, stated };
  });

  return {
    ok: true,
    report: {
      title: source.title,
      columns,
      hiddenColumns,
      criteria,
      unnamed,
      ownerComplete: source.ownerComplete,
      statedVerdict: source.statedVerdict,
      limitations: source.limitations,
    },
  };
}

// ---------------------------------------------------------------------------
// Saying it

/** A criterion is a gap when it isn't passed (n/a ones aren't gaps). */
export function isGap(criterion: Criterion): boolean {
  return !criterion.own.notApplicable && criterion.own.status !== "passed";
}

export function isCellGap(check: Check): boolean {
  return !check.notApplicable && check.status !== "passed";
}

export const STATUS_LABEL: Readonly<Record<AcceptanceStatus, string>> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  untested: "Not tested",
  claimed: "Claimed",
  skipped: "Skipped",
};

/** How a count of criteria (or cells) in a status reads in the verdict: "2 failing", "2 only claimed". */
export const COUNT_WORD: Readonly<Record<AcceptanceStatus, string>> = {
  passed: "proven",
  failed: "failing",
  blocked: "blocked",
  untested: "not tested",
  claimed: "only claimed",
  skipped: "skipped",
};

/** What a check says, in words: "Verified by reviewer", "Claimed by owner, not independently checked", "Not applicable". */
export function checkLabel(check: Check): string {
  if (check.notApplicable) return "Not applicable";
  if (!check.recorded) return "No result recorded";
  const given = check.given === null ? "" : ` (${check.given})`;
  switch (check.status) {
    case "passed":
      return check.by === null ? `Passed${given}` : `Verified by ${check.by}${given}`;
    case "claimed":
      return `Claimed${check.by === null ? "" : ` by ${check.by}`}${given}, not independently checked`;
    case "untested":
      return check.known ? `Not tested${given}` : `Not tested: “${check.given}” is not a known status`;
    case "blocked":
      return check.needs !== null ? `Blocked, needs you${check.needs === "" ? "" : `: ${check.needs}`}` : `Blocked${given}`;
    default:
      return `${STATUS_LABEL[check.status]}${given}`;
  }
}

export type StatusCounts = Readonly<Record<AcceptanceStatus, number>>;

function emptyCounts(): Record<AcceptanceStatus, number> {
  return { passed: 0, failed: 0, blocked: 0, untested: 0, claimed: 0, skipped: 0 };
}

/** One thing the user has to do, and every criterion or cell waiting on it. */
export interface NeedsYou {
  /** What is needed ("Connect and unlock the iPhone"): the `needs` text, else the note; "" when only the status said so. */
  readonly what: string;
  /** The criteria waiting on it, in order, each with the columns (cells) that wait; no columns for a criterion's own result. */
  readonly where: readonly { readonly criterion: string; readonly columns: readonly string[] }[];
}

/**
 * Where a need applies, in a few words: "Plays a live Rook match (Source
 * server, Published site)", or for a block of cells "iPhone · Whisper and
 * iPhone · LiteRT in Tier 1, Tier 2 and 1 more". `limit` names at most that
 * many criteria.
 */
export function needsPlaces(item: NeedsYou, limit = Number.POSITIVE_INFINITY): string {
  const names = (list: readonly string[]) => {
    const shown = list.length > limit + 1 ? list.slice(0, limit) : list;
    const more = list.length - shown.length;
    const all = more > 0 ? [...shown, `${more} more`] : shown;
    return all.length <= 1 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
  };
  const columns = [...new Set(item.where.flatMap((place) => place.columns))];
  const sameColumns = item.where.every((place) => place.columns.length === columns.length);
  if (columns.length > 0 && item.where.length > 1 && sameColumns) return `${names(columns)} in ${names(item.where.map((place) => place.criterion))}`;
  return names(item.where.map((place) => (place.columns.length === 0 ? place.criterion : `${place.criterion} (${place.columns.join(", ")})`)));
}

export interface Verdict {
  /** "Done", "Not done", "Not proven", "No criteria". */
  readonly headline: string;
  readonly tone: "good" | "warn" | "bad" | "neutral";
  /** "3 of 8 criteria proven". */
  readonly proven: string;
  /** Required criteria per status (n/a ones aside). */
  readonly counts: StatusCounts;
  /** "2 failing", "1 blocked", "2 only claimed", worst first, non-zero only. */
  readonly parts: readonly string[];
  /** The matrix's cells per status (n/a cells aside), with how many there are; null in the single-status form. */
  readonly cells: { readonly total: number; readonly counts: StatusCounts; readonly notApplicable: number } | null;
  readonly required: number;
  readonly optional: { readonly total: number; readonly proven: number };
  readonly notApplicable: number;
  readonly needsYou: readonly NeedsYou[];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The verdict in plain words, from required criteria; optional ones are counted apart. */
export function acceptanceVerdict(report: AcceptanceReport): Verdict {
  const counts = emptyCounts();
  let required = 0;
  let notApplicable = 0;
  let optionalTotal = 0;
  let optionalProven = 0;
  const needsYou = new Map<string, { what: string; where: { criterion: string; columns: string[] }[] }>();
  const addNeed = (check: Check, criterion: string, column: string | null) => {
    const what = check.needs || (check.note ?? "");
    const key = what.toLowerCase();
    let group = needsYou.get(key);
    if (group === undefined) needsYou.set(key, (group = { what, where: [] }));
    let place = group.where.find((entry) => entry.criterion === criterion);
    if (place === undefined) group.where.push((place = { criterion, columns: [] }));
    if (column !== null) place.columns.push(column);
  };
  let cells: { total: number; counts: Record<AcceptanceStatus, number>; notApplicable: number } | null = null;
  if (report.columns.length > 0) cells = { total: 0, counts: emptyCounts(), notApplicable: 0 };
  for (const criterion of report.criteria) {
    if (criterion.own.needs !== null && criterion.own.status !== "passed") addNeed(criterion.own, criterion.name, null);
    criterion.cells?.forEach((check, position) => {
      if (check.needs !== null) addNeed(check, criterion.name, report.columns[position] ?? "");
      if (cells === null || !criterion.required) return;
      if (check.notApplicable) cells.notApplicable++;
      else {
        cells.total++;
        cells.counts[check.status]++;
      }
    });
    if (criterion.own.notApplicable) {
      if (criterion.required) notApplicable++;
      continue;
    }
    if (!criterion.required) {
      optionalTotal++;
      if (criterion.own.status === "passed") optionalProven++;
      continue;
    }
    required++;
    counts[criterion.own.status]++;
  }
  const noun = optionalTotal > 0 ? ["required criterion", "required criteria"] : ["criterion", "criteria"];
  const parts = STATUS_ORDER.filter((status) => status !== "passed" && counts[status] > 0).map((status) => `${counts[status]} ${COUNT_WORD[status]}`);
  const proven = required === 0 ? plural(0, noun[0]!, noun[1]!) : `${counts.passed} of ${plural(required, noun[0]!, noun[1]!)} proven`;
  let headline: string;
  let tone: Verdict["tone"];
  if (report.criteria.length === 0) {
    headline = "No criteria";
    tone = "neutral";
  } else if (required === 0) {
    headline = optionalTotal > 0 ? "Nothing required" : "Not applicable";
    tone = "neutral";
  } else if (counts.passed === required) {
    headline = "Done";
    tone = "good";
  } else if (counts.failed + counts.blocked + counts.untested > 0) {
    headline = "Not done";
    tone = counts.failed > 0 ? "bad" : "warn";
  } else {
    headline = "Not proven";
    tone = "warn";
  }
  return {
    headline,
    tone,
    proven: headline === "Done" ? `all ${plural(required, noun[0]!, noun[1]!)} proven` : proven,
    counts,
    parts,
    cells,
    required,
    optional: { total: optionalTotal, proven: optionalProven },
    notApplicable,
    needsYou: [...needsYou.values()],
  };
}

/** "Not done: 3 of 8 criteria proven · 2 failing · 1 blocked · 2 only claimed". */
export function verdictLine(verdict: Verdict): string {
  if (verdict.headline === "No criteria") return "No criteria yet";
  return [`${verdict.headline}: ${verdict.proven}`, ...verdict.parts].join(" · ");
}

/** The matrix's cells in words: "24 cells: 24 blocked", "72 cells: 2 proven · 70 untested". */
export function cellsLine(verdict: Verdict): string | null {
  const cells = verdict.cells;
  if (cells === null || cells.total === 0) return null;
  const parts = [...STATUS_ORDER].reverse().filter((status) => cells.counts[status] > 0).map((status) => `${cells.counts[status]} ${COUNT_WORD[status]}`);
  const na = cells.notApplicable > 0 ? ` (${cells.notApplicable} not applicable)` : "";
  return `${plural(cells.total, "cell", "cells")}${na}: ${parts.join(" · ")}`;
}

/** What the owner said against what is proven: "Owner reports complete; 5 criteria are not proven". Null when it said nothing or agrees. */
export function ownerContradiction(report: AcceptanceReport, verdict: Verdict): string | null {
  if (report.ownerComplete !== true || verdict.headline === "Done" || verdict.required === 0) return null;
  const open = verdict.required - verdict.counts.passed;
  return `Owner reports complete, but ${plural(open, "required criterion is", "required criteria are")} not proven`;
}

/** The text a criterion's or cell's copy button copies: `Criterion · column: label — note`. */
export function checkSummary(criterion: string, column: string | null, check: Check): string {
  const note = check.note === null ? "" : ` — ${check.note}`;
  return `${criterion}${column === null ? "" : ` · ${column}`}: ${checkLabel(check)}${note}`;
}
