// Data by reference: `Load("path")` reads a file the host fetched before
// evaluation, so agents bind tool results instead of retyping their values;
// `Snippet("path", from, to)` shows lines of a file the same way.
import type { Expr, Program } from "./ast";
import { LIMITS } from "./catalog";
import type { Pos } from "./diagnostics";
import { JUnitError, readJUnit } from "./junit";
import type { Value } from "./types";

export type LoadedData = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: string };

/** One file the host fetches before evaluation: parsed by extension for Load, raw text for Snippet. */
export interface DataRequest {
  readonly path: string;
  readonly raw: boolean;
}

/** The data-map key of a request, so `Load("a.json")` and `Snippet("a.json")` never share an entry. */
export function dataKey(request: DataRequest): string {
  return `${request.raw ? "raw" : "load"}:${request.path}`;
}

/** Lines a Snippet shows at most; longer ranges are cut at `from + MAX_SNIPPET_LINES - 1`. */
export const MAX_SNIPPET_LINES = 400;

/** The path of a `Load` argument when it is a plain string (no `${}`), else null. */
export function loadPath(arg: Expr | undefined): string | null {
  if (arg?.type === "literal" && typeof arg.value === "string") return arg.value;
  if (arg?.type === "template" && arg.parts.length === 0) return arg.quasis[0];
  return null;
}

/** Files the spec reads: Load paths (parsed) and Snippet paths (raw), in source order, deduplicated. */
export function collectLoads(program: Program): DataRequest[] {
  const found: { readonly request: DataRequest; readonly pos: Pos }[] = [];
  const visit = (expr: Expr): void => {
    switch (expr.type) {
      case "literal":
      case "state":
      case "ident":
        return;
      case "template":
        expr.parts.forEach(visit);
        return;
      case "list":
        expr.items.forEach(visit);
        return;
      case "object":
        for (const entry of expr.entries) visit(entry.value);
        return;
      case "unary":
        visit(expr.operand);
        return;
      case "binary":
        visit(expr.left);
        visit(expr.right);
        return;
      case "conditional":
        visit(expr.test);
        visit(expr.then);
        visit(expr.else);
        return;
      case "member":
        visit(expr.object);
        return;
      case "index":
        visit(expr.object);
        visit(expr.index);
        return;
      case "arrow":
        visit(expr.body);
        return;
      case "method":
        visit(expr.object);
        expr.args.forEach(visit);
        for (const arg of expr.named) visit(arg.value);
        return;
      case "call": {
        if (expr.name === "Load") {
          const path = loadPath(expr.args[0]);
          if (path) found.push({ request: { path, raw: false }, pos: expr.pos });
        } else if (expr.name === "Snippet") {
          // The path is the first argument, or named `path:`.
          const path = loadPath(expr.args[0] ?? expr.named.find((arg) => arg.name === "path")?.value);
          if (path) found.push({ request: { path, raw: true }, pos: expr.pos });
        }
        expr.args.forEach(visit);
        for (const arg of expr.named) visit(arg.value);
        return;
      }
    }
  };
  for (const decl of program.states) visit(decl.value);
  for (const decl of program.named.values()) visit(decl.value);
  program.roots.forEach(visit);
  found.sort((a, b) => a.pos.line - b.pos.line || a.pos.column - b.pos.column);
  const requests = new Map<string, DataRequest>();
  for (const { request } of found) if (!requests.has(dataKey(request))) requests.set(dataKey(request), request);
  return [...requests.values()];
}

/**
 * The files the given expressions read their data from: every `Load` they
 * reach, following named values, `$state` initializers and named functions
 * to their definitions (each once, so a cycle ends), in the order reached.
 * An arrow's parameters shadow the top-level names they share. Only plain
 * string paths count, the only ones collectLoads has the host fetch.
 */
export function loadsReached(program: Program, exprs: readonly Expr[]): string[] {
  const paths = new Set<string>();
  const followed = new Set<string>();
  const follow = (key: string, decl: Expr | undefined): void => {
    if (decl === undefined || followed.has(key)) return;
    followed.add(key);
    // A named function sees only its parameters and the top-level names.
    if (decl.type === "arrow") visit(decl.body, new Set(decl.params));
    else visit(decl, new Set());
  };
  const visit = (expr: Expr, bound: ReadonlySet<string>): void => {
    switch (expr.type) {
      case "literal":
        return;
      case "state":
        follow(`$${expr.name}`, program.states.find((decl) => decl.name === expr.name)?.value);
        return;
      case "ident":
        if (!bound.has(expr.name)) follow(expr.name, program.named.get(expr.name)?.value);
        return;
      case "template":
        for (const part of expr.parts) visit(part, bound);
        return;
      case "list":
        for (const item of expr.items) visit(item, bound);
        return;
      case "object":
        for (const entry of expr.entries) visit(entry.value, bound);
        return;
      case "unary":
        visit(expr.operand, bound);
        return;
      case "binary":
        visit(expr.left, bound);
        visit(expr.right, bound);
        return;
      case "conditional":
        visit(expr.test, bound);
        visit(expr.then, bound);
        visit(expr.else, bound);
        return;
      case "member":
        visit(expr.object, bound);
        return;
      case "index":
        visit(expr.object, bound);
        visit(expr.index, bound);
        return;
      case "arrow":
        visit(expr.body, new Set([...bound, ...expr.params]));
        return;
      case "method":
        visit(expr.object, bound);
        for (const arg of expr.args) visit(arg, bound);
        for (const arg of expr.named) visit(arg.value, bound);
        return;
      case "call": {
        if (expr.name === "Load") {
          const path = loadPath(expr.args[0]);
          if (path) paths.add(path);
          return;
        }
        const own = bound.has(expr.name) ? undefined : program.named.get(expr.name)?.value;
        if (own?.type === "arrow") follow(expr.name, own);
        for (const arg of expr.args) visit(arg, bound);
        for (const arg of expr.named) visit(arg.value, bound);
        return;
      }
    }
  };
  for (const expr of exprs) visit(expr, new Set());
  return [...paths];
}

/** The lines a Snippet shows, or a user-facing reason it cannot show them. */
export type SnippetLines = { readonly code: string; readonly error: null } | { readonly code: null; readonly error: string };

/** Why `from`/`to` cannot address lines, or null; checked before the file arrives. */
export function snippetRangeError(from: number | null, to: number | null): string | null {
  for (const [name, line] of [["from", from], ["to", to]] as const) {
    if (line !== null && (!Number.isInteger(line) || line < 1)) return `\`${name}\` must be a line number (1 or more), got ${line}`;
  }
  if (from !== null && to !== null && from > to) return `\`from\` (${from}) is after \`to\` (${to})`;
  return null;
}

/**
 * Lines `from`..`to` of `text` (1-based, inclusive). `from` defaults to 1 and
 * `to` to the last line; `to` is clamped to the file, and at most
 * MAX_SNIPPET_LINES lines are returned.
 */
export function snippetLines(text: string, from: number | null, to: number | null): SnippetLines {
  const rangeError = snippetRangeError(from, to);
  if (rangeError !== null) return { code: null, error: rangeError };
  const lines = text.split(/\r?\n/);
  // A final newline ends the last line; it does not start another.
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { code: null, error: "the file is empty" };
  const start = from ?? 1;
  if (start > lines.length) {
    return { code: null, error: `the file has ${lines.length} line${lines.length === 1 ? "" : "s"}; \`from\` is ${start}` };
  }
  const end = Math.min(to ?? lines.length, lines.length, start + MAX_SNIPPET_LINES - 1);
  return { code: lines.slice(start - 1, end).join("\n"), error: null };
}

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", m: "objective-c", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", scala: "scala", dart: "dart", lua: "lua", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", clj: "clojure", zig: "zig", r: "r", jl: "julia", pl: "perl",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",
  json: "json", jsonc: "jsonc", jsonl: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", xml: "xml",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less", vue: "vue", svelte: "svelte", astro: "astro",
  md: "markdown", mdx: "mdx", sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  tf: "hcl", hcl: "hcl", nix: "nix", diff: "diff", patch: "diff", csv: "csv", txt: "text",
};

const FILE_NAMES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
};

/** The language of a file, by extension or well-known name; null if unknown. */
export function languageOf(path: string): string | null {
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (Object.hasOwn(FILE_NAMES, name)) return FILE_NAMES[name];
  const extension = /\.([^.]+)$/.exec(name)?.[1];
  return extension !== undefined && Object.hasOwn(LANGUAGES, extension) ? LANGUAGES[extension] : null;
}

/**
 * Parses file text by extension: .json (and .sarif, .har, which are JSON) -> JSON; .jsonl/.ndjson -> list of
 * values (one per non-empty line); .csv/.tsv -> list of objects keyed by the
 * header row (RFC 4180 quoting for csv; numeric-looking cells become numbers,
 * empty cells null, true/false booleans); .xml -> a JUnit test report as the
 * list `Tests` takes (any other XML is refused); anything else -> the text as a
 * string. Lists longer than LIMITS.loadedListLength are an error. Objects whose
 * `kind` is "node", "action" or "binding" anywhere in the data are an error
 * (loaded data must never pose as interpreter values). Malformed input is
 * { ok: false } with a short reason, never a throw.
 */
export function parseDataFile(path: string, text: string): LoadedData {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const extension = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase();
  let value: unknown;
  try {
    switch (extension) {
      case "json":
      case "sarif":
      case "har":
        value = JSON.parse(body);
        break;
      case "jsonl":
      case "ndjson":
        value = parseJsonLines(body);
        break;
      case "csv":
        value = table(parseCsv(body));
        break;
      case "tsv":
        value = table(body.split(/\r?\n/).filter((line) => line !== "").map((line) => line.split("\t")));
        break;
      case "xml":
        value = readJUnit(body);
        break;
      default:
        return { ok: true, value: body };
    }
  } catch (error) {
    if (error instanceof DataError || error instanceof JUnitError) return { ok: false, error: error.message };
    // Only JSON.parse of a .json file gets here: SyntaxError, or RangeError for deep nesting.
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const problem = check(value);
  if (problem !== null) return { ok: false, error: problem };
  // check() walked every node: JSON and table cells are scalars, lists and plain objects.
  const checked = value as Value;
  return { ok: true, value: checked };
}

/** A malformed-input reason, already phrased for the user. */
class DataError extends Error {}

function parseJsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new DataError(`line ${index + 1} is not valid JSON`);
    }
  });
  return values;
}

/** RFC 4180 records: `"` quotes a field, `""` escapes a quote, quoted fields may hold commas and newlines. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let line = 1;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // Blank lines carry no record.
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
  };
  while (i < text.length) {
    const char = text[i];
    if (char === '"' && field === "") {
      const start = line;
      i++;
      for (;;) {
        if (i >= text.length) throw new DataError(`a quoted field starting on line ${start} never closes`);
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break;
          field += '"';
          i += 2;
        } else {
          if (text[i] === "\n") line++;
          field += text[i++];
        }
      }
      i++;
      const next = text[i];
      if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") {
        throw new DataError(`unexpected text after a closing quote on line ${line}`);
      }
    } else if (char === ",") {
      endField();
      i++;
    } else if (char === "\n" || char === "\r") {
      endRecord();
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
    } else {
      field += char;
      i++;
    }
  }
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/** Header row + records → objects; cells are typed by `cell`. */
function table(records: readonly string[][]): Record<string, Value>[] {
  const [header, ...rows] = records;
  if (header === undefined) return [];
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) throw new DataError(`the header names column "${name}" twice`);
    seen.add(name);
  }
  return rows.map((row, index) => {
    if (row.length > header.length) {
      throw new DataError(`row ${index + 1} has ${row.length} cells; the header has ${header.length}`);
    }
    // fromEntries defines own properties, so a `__proto__` column stays plain data.
    return Object.fromEntries(header.map((name, column) => [name, cell(row[column] ?? "")]));
  });
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;

/** Numbers (JSON syntax, so "007" stays text), true/false, empty → null; anything else stays text. */
function cell(text: string): Value {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (NUMBER.test(trimmed)) return Number(trimmed);
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") return lower === "true";
  return text;
}

/** Why parsed data cannot be a Value, or null. Iterative, so deep nesting cannot overflow the stack. */
function check(root: unknown): string | null {
  if (Array.isArray(root) && root.length > LIMITS.loadedListLength) {
    return `the file has ${root.length} rows; the limit is ${LIMITS.loadedListLength}`;
  }
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      if (value.length > LIMITS.loadedListLength) {
        return `a list in the file has ${value.length} items; the limit is ${LIMITS.loadedListLength}`;
      }
      for (const item of value) pending.push(item);
    } else if (typeof value === "object" && value !== null) {
      if ("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding" || value.kind === "function")) {
        return `\`kind: "${value.kind}"\` is reserved; loaded data cannot use it`;
      }
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return null;
}
