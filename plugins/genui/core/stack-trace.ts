// What `StackTrace` shows: an error as a runtime printed it (or as
// `{name, message, stack}`) read into the error that surfaced, its causes and
// an AggregateError's errors, each with its frames innermost first, for
// JavaScript (Node, V8, Firefox, Safari), Python, Java/Kotlin, Go, Rust, .NET,
// Ruby and Swift. Frame locations and the app/library split come from
// `stackFrame` in test-results.ts. Pure: no React, no DOM.
import { isPlainObject } from "./evaluate";
import { JVM_LIBRARY, stackFrame, stripAnsi, type StackFrame } from "./test-results";
import type { Value } from "./types";

export type TraceLanguage = "javascript" | "python" | "java" | "go" | "rust" | "dotnet" | "ruby" | "swift" | "text";

export interface TraceFrame {
  /** The frame as printed, trimmed; a frame printed on two lines (Go, Rust) is both, joined by a space. */
  readonly text: string;
  readonly fn: string | null;
  readonly location: StackFrame | null;
  /** The code being debugged, not a dependency, the runtime or the standard library. */
  readonly app: boolean;
  /** The source line Python prints under a frame. */
  readonly source: string | null;
}

/**
 * How a section relates to the section it belongs to: `cause` (Caused by,
 * `[cause]`, Python's "direct cause", .NET's inner exception), `context`
 * (Python: raised while this one was being handled), `member` (one of an
 * AggregateError's errors), `suppressed` (Java).
 */
export type TraceRelation = "cause" | "context" | "member" | "suppressed";

export interface TraceSection {
  /** `TypeError`, `java.lang.IllegalStateException`, `panic`; "" when the text names none. */
  readonly type: string;
  readonly message: string;
  /** Innermost (where it was thrown) first. */
  readonly frames: readonly TraceFrame[];
  /** Frames the runtime left out as shared with another section (Java `... 6 more`, Node `... 2 lines matching cause stack trace ...`). */
  readonly omitted: number;
  /** Properties printed with the error (Node's `code: 'ECONNREFUSED'`). */
  readonly fields: readonly (readonly [string, string])[];
  /** Null for the error that surfaced, which comes first. */
  readonly relation: TraceRelation | null;
  /** 0 for the top error and its causes; one more inside each AggregateError or Java `Suppressed:` list. */
  readonly depth: number;
}

export interface Trace {
  readonly language: TraceLanguage;
  readonly sections: readonly TraceSection[];
  /** Where it ran, as printed: `Node.js v22.1.0`, `thread 'main'`, `goroutine 1 [running]`, `exit status 2`. */
  readonly notes: readonly string[];
  /** The runtime printed the frames outermost first (Python), so they are shown reversed. */
  readonly reversed: boolean;
  /** The text read, ANSI codes stripped: what Copy copies. */
  readonly raw: string;
}

export type TraceResult = { readonly ok: true; readonly trace: Trace } | { readonly ok: false; readonly error: string };

const SHAPE_HINT = "StackTrace needs an error's text with its stack, or {name, message, stack}";

interface Section {
  type: string;
  message: string;
  frames: TraceFrame[];
  omitted: number;
  fields: [string, string][];
  relation: TraceRelation | null;
  depth: number;
  /** Indentation of the header line (JavaScript nesting). */
  indent: number;
  /** A `{` after the header or last frame opened a block of printed properties. */
  braces: boolean;
}

interface Parsed {
  language: TraceLanguage;
  sections: Section[];
  notes: string[];
  reversed: boolean;
}

function section(header: string, relation: TraceRelation | null, depth: number, indent = 0): Section {
  const { type, message } = splitHeader(header);
  return { type, message, frames: [], omitted: 0, fields: [], relation, depth, indent, braces: false };
}

/** `Type: message` → its parts; text that names no type is all message. */
export function splitHeader(text: string): { readonly type: string; readonly message: string } {
  const trimmed = text.trim();
  const match = /^((?:[A-Za-z_$][\w$]*[.:/]{1,2})*[A-Za-z_$][\w$]*(?: ?\[[\w-]+\])?)(?::(?:\s+|$)([\s\S]*))?$/.exec(trimmed);
  if (match !== null && (match[2] !== undefined || /(?:Error|Exception|Throwable|Panic|Warning|Interrupt|Exit)$/.test(match[1]))) {
    return { type: match[1], message: (match[2] ?? "").trim() };
  }
  return { type: "", message: trimmed };
}

function appendMessage(target: Section, line: string): void {
  target.message = target.message === "" ? line : `${target.message}\n${line}`;
}

function frame(text: string, fn: string | null, location: StackFrame | null, app: boolean, source: string | null = null): TraceFrame {
  return { text: text.trim(), fn: fn === null || fn.trim() === "" ? null : fn.trim(), location, app, source };
}

// ---------------------------------------------------------------------------
// Input

/** The error `value` describes, read; an error for anything that is no trace. */
export function readTrace(value: Value | undefined): TraceResult {
  if (value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (!isPlainObject(value as Value)) return { ok: false, error: SHAPE_HINT };
    const parsed = fromObject(value as Readonly<Record<string, Value>>, null, 0, 0);
    if (parsed === null) return { ok: false, error: SHAPE_HINT };
    return { ok: true, trace: finish(parsed.parsed, parsed.raw) };
  }
  const text = Array.isArray(value)
    ? value.every((line) => typeof line === "string")
      ? value.join("\n")
      : null
    : typeof value === "string"
      ? value
      : null;
  if (text === null) return { ok: false, error: SHAPE_HINT };
  const raw = clean(text);
  if (raw === "") return { ok: false, error: "The trace is empty" };
  return { ok: true, trace: finish(parse(raw), raw) };
}

function clean(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

function finish(parsed: Parsed, raw: string): Trace {
  const sections = parsed.sections
    .filter((s, index) => index === 0 || s.type !== "" || s.message !== "" || s.frames.length > 0)
    .map(({ type, message, frames, omitted, fields, relation, depth }) => ({ type, message, frames, omitted, fields, relation, depth }));
  return { language: parsed.language, sections, notes: parsed.notes, reversed: parsed.reversed, raw };
}

function field(record: Readonly<Record<string, Value>>, keys: readonly string[]): Value | undefined {
  for (const key of keys) if (Object.hasOwn(record, key) && record[key] !== null) return record[key];
  return undefined;
}

function fieldText(value: Value | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("\n");
  return null;
}

/**
 * `{name, message, stack, cause?, errors?}` (a serialized Error, pino's
 * `err`, a browser's error event). A stack that does not repeat the header
 * (Firefox, Safari) gets it put in front.
 */
function fromObject(
  record: Readonly<Record<string, Value>>,
  relation: TraceRelation | null,
  depth: number,
  level: number,
): { parsed: Parsed; raw: string } | null {
  const name = fieldText(field(record, ["name", "type", "errorType", "class"]))?.trim() ?? "";
  const message = fieldText(field(record, ["message", "msg", "reason", "value"])) ?? "";
  const stack = fieldText(field(record, ["stack", "stacktrace", "traceback", "backtrace"]));
  if (name === "" && message === "" && stack === null) return null;
  const header = name === "" ? message : message === "" ? name : `${name}: ${message}`;
  let text = clean(stack ?? header);
  if (stack !== null) {
    const first = text.split("\n", 1)[0].trim();
    const framesOnly = first === "" || stackFrame(first) !== null || /^at\s|@/.test(first) || /^\s/.test(text);
    if (framesOnly && header !== "" && !(message !== "" && first.includes(message.split("\n", 1)[0]))) text = `${header}\n${text}`;
  }
  const parsed = parse(text);
  const sections = parsed.sections;
  if (sections.length > 0) {
    sections[0].relation = relation;
    for (const each of sections) each.depth += depth;
  }
  let raw = text;
  if (level < 8) {
    const cause = field(record, ["cause"]);
    if (cause !== undefined && isPlainObject(cause)) {
      const read = fromObject(cause, "cause", depth, level + 1);
      if (read !== null) {
        sections.push(...read.parsed.sections);
        raw += `\nCaused by: ${read.raw}`;
      }
    }
    const errors = field(record, ["errors"]);
    if (Array.isArray(errors)) {
      for (const item of errors.slice(0, 50)) {
        if (!isPlainObject(item)) continue;
        const read = fromObject(item, "member", depth + 1, level + 1);
        if (read !== null) {
          sections.push(...read.parsed.sections);
          raw += `\n  ${read.raw.split("\n").join("\n  ")}`;
        }
      }
    }
  }
  return { parsed, raw };
}

// ---------------------------------------------------------------------------
// Dispatch

const PYTHON = /^\s*Traceback \(most recent call last\):\s*$/m;
const GO = /^(?:panic|fatal error): /m;
const RUST = /^thread '[^']*'(?: \(\d+\))? panicked at /m;
const DOTNET = /^\s*at \S.*\) in \S.*:line \d+\s*$|^\s*---> \S|^Unhandled exception\. /m;
const JAVA = /^\s*at [\w$.<>/-]+\((?:[\w$.-]+\.(?:java|kt|kts|scala|groovy|clj)(?::\d+)?|Native Method|Unknown Source)\)\s*$/m;
const RUBY = /^\S+?:\d+:in [`'].*?': [\s\S]*?\([\w:]+\)\s*$|^\s+from \S+?:\d+:in [`']/m;
const SWIFT = /^\S+?\.swift:\d+: Fatal error: /m;

function parse(text: string): Parsed {
  if (PYTHON.test(text)) return parsePython(text);
  if (GO.test(text) && /\.go:\d+/.test(text)) return parseGo(text);
  if (RUST.test(text)) return parseRust(text);
  if (DOTNET.test(text)) return parseDotnet(text);
  if (JAVA.test(text)) return parseJava(text);
  if (RUBY.test(text)) return parseRuby(text);
  if (SWIFT.test(text)) return parseSwift(text);
  return parseJavaScript(text);
}

// ---------------------------------------------------------------------------
// JavaScript: V8 (Node, Chrome, Deno, Bun), Firefox, Safari, and any text

const V8_FRAME = /^at\s+(?:(.+?)\s+\((.*)\)|(.+))$/;
const AT_SIGN_FRAME = /^([^\s@]*)@(\S.*?)$/;
const RUNTIME_NOTE = /^(?:Node\.js|Deno|Bun) v\d[\w.-]*$/;
const OMITTED = /^\.\.\. (\d+) lines? matching cause stack trace \.\.\.$/;
const PROPERTY = /^((?:[\w$]+|'[^']*'|"[^"]*"|\[[\w$.]+\])):\s(.*?),?$/;

function parseJavaScript(text: string): Parsed {
  const lines = text.split("\n");
  const sections: Section[] = [];
  const notes: string[] = [];
  /** Open `[errors]: [` lists: their indentation, their members' (once seen) and the depth of the AggregateError holding them. */
  const lists: { indent: number; members: number | null; depth: number }[] = [];
  let browser = false;
  let start = 0;
  // Node's uncaught-exception preamble: `file:line`, the source line, a caret, a blank line.
  if (/^(?:file:\/\/)?\S+:\d+$/.test(lines[0].trim()) && lines.slice(1, 4).some((line) => /^\s*\^+\s*$/.test(line))) {
    const blank = lines.findIndex((line, index) => index > 0 && line.trim() === "");
    start = blank === -1 ? 1 : blank + 1;
  }
  const current = (): Section | undefined => sections[sections.length - 1];
  const open = (header: string, relation: TraceRelation | null, indent: number): Section => {
    let depth = 0;
    if (relation === "member") depth = (lists[lists.length - 1]?.depth ?? 0) + 1;
    else if (relation !== null) {
      const before = [...sections].reverse();
      const owner = before.find((s) => s.indent < indent) ?? before.find((s) => s.indent <= indent);
      depth = owner?.depth ?? 0;
    }
    let body = header.trim();
    let braces = false;
    if (body.endsWith(" {")) {
      body = body.slice(0, -2).trimEnd();
      braces = true;
    }
    // Node prints errors without a stack as `[TypeError: fetch failed]`.
    const bracketed = /^\[(.*)\]$/.exec(body);
    if (bracketed !== null) body = bracketed[1];
    const made = section(body.replace(/^Uncaught (?:\(in promise\) )?/, ""), relation, depth, indent);
    made.braces = braces;
    sections.push(made);
    return made;
  };
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (trimmed === "") continue;
    if (RUNTIME_NOTE.test(trimmed)) {
      notes.push(trimmed);
      continue;
    }
    const omitted = OMITTED.exec(trimmed);
    if (omitted !== null) {
      if (current() !== undefined) current()!.omitted += Number(omitted[1]);
      continue;
    }
    let body = trimmed;
    let braces = false;
    if (/^at\s/.test(body)) {
      // Inside Node's printed objects a frame line may end the error (`,`) or open its properties (` {`).
      body = body.replace(/,$/, "");
      if (body.endsWith(" {")) {
        body = body.slice(0, -2);
        braces = true;
      }
    }
    const v8 = V8_FRAME.exec(body);
    const atSign = v8 === null && (!body.includes(" ") || body.endsWith("@[native code]")) ? AT_SIGN_FRAME.exec(body) : null;
    if (v8 !== null || (atSign !== null && (stackFrame(body) !== null || /@\[native code\]$|@(?:https?|file|webpack[\w-]*|blob|chrome-extension|moz-extension):/.test(body)))) {
      if (atSign !== null) browser = true;
      const target = current() ?? open("", null, indent);
      const location = stackFrame(body);
      const fn = v8 !== null ? (v8[1] ?? null) : atSign![1];
      target.frames.push(frame(body, fn, location, location?.app ?? false));
      if (braces) target.braces = true;
      continue;
    }
    if (/^\[errors\]: \[$/.test(trimmed)) {
      lists.push({ indent, members: null, depth: current()?.depth ?? 0 });
      continue;
    }
    if (/^[\]}],?$/.test(trimmed)) {
      if (trimmed.startsWith("]") && lists.length > 0) lists.pop();
      else if (current() !== undefined) current()!.braces = false;
      continue;
    }
    const cause = /^(?:\[cause\]:|Caused by:)\s*(.*)$/.exec(trimmed);
    if (cause !== null) {
      open(cause[1], "cause", indent);
      continue;
    }
    // Each of an AggregateError's errors starts at the indentation of the first one.
    const list = lists[lists.length - 1];
    if (list !== undefined && (list.members === null ? indent > list.indent : indent === list.members)) {
      list.members = indent;
      open(trimmed.replace(/,$/, ""), "member", indent);
      continue;
    }
    const target = current();
    if (target === undefined) {
      open(trimmed, null, indent);
      continue;
    }
    if (target.braces) {
      const property = PROPERTY.exec(trimmed);
      if (property !== null) {
        target.fields.push([property[1].replace(/^['"[]|['"\]]$/g, ""), property[2].replace(/^'(.*)'$/, "$1")]);
        if (property[2].endsWith("{") || property[2].endsWith("[")) target.braces = true;
        continue;
      }
    }
    if (target.frames.length === 0) {
      appendMessage(target, trimmed);
      continue;
    }
    // A frame some other way (`src/a.ts:12:5`, a pytest location): kept; anything else after the frames is left out.
    const location = stackFrame(line);
    if (location !== null) target.frames.push(frame(trimmed, null, location, location.app));
  }
  const hasV8 = sections.some((s) => s.frames.some((f) => f.text.startsWith("at ")));
  return { language: browser || hasV8 ? "javascript" : "text", sections: sections.length > 0 ? sections : [section(text, null, 0)], notes, reversed: false };
}

// ---------------------------------------------------------------------------
// Python: chained tracebacks, frames printed outermost first

const PYTHON_FRAME = /^(\s*)File "([^"]+)", line (\d+)(?:, in (.+))?$/;
const PYTHON_CHAIN: Readonly<Record<string, TraceRelation>> = {
  "The above exception was the direct cause of the following exception:": "cause",
  "During handling of the above exception, another exception occurred:": "context",
};

function parsePython(text: string): Parsed {
  const chunks: { lines: string[]; joined: TraceRelation | null }[] = [{ lines: [], joined: null }];
  for (const line of text.split("\n")) {
    const relation = PYTHON_CHAIN[line.trim()];
    if (relation !== undefined) chunks.push({ lines: [], joined: relation });
    else chunks[chunks.length - 1].lines.push(line);
  }
  const read = chunks.map((chunk) => {
    const lines = chunk.lines;
    const begin = lines.findIndex((line) => PYTHON.test(line));
    const frames: TraceFrame[] = [];
    let exception: string[] = [];
    for (let index = begin + 1; index < lines.length; index++) {
      const line = lines[index];
      const match = PYTHON_FRAME.exec(line);
      if (match !== null) {
        const depth = match[1].length;
        let source: string | null = null;
        while (index + 1 < lines.length) {
          const next = lines[index + 1];
          if (next.trim() !== "" && next.length - next.trimStart().length <= depth) break;
          index++;
          if (source === null && next.trim() !== "" && !/^\s*[~^]+\s*$/.test(next)) source = next.trim();
        }
        const location = stackFrame(line);
        frames.push(frame(line, match[4] ?? null, location, location?.app ?? false, source));
        continue;
      }
      if (line.trim() !== "") {
        exception = lines.slice(index).filter((rest, at, all) => rest.trim() !== "" || at < all.length - 1);
        break;
      }
    }
    const header = exception.join("\n").trim();
    const made = section(header, null, 0);
    if (begin === -1) made.message = lines.join("\n").trim();
    made.frames = frames.reverse();
    return { made, joined: chunk.joined };
  });
  // The exception that surfaced is printed last; each earlier one is joined to the next by the line between them.
  const sections: Section[] = [];
  for (let index = read.length - 1; index >= 0; index--) {
    const made = read[index].made;
    made.relation = index === read.length - 1 ? null : read[index + 1].joined;
    sections.push(made);
  }
  return { language: "python", sections, notes: [], reversed: true };
}

// ---------------------------------------------------------------------------
// Go: a panic and its goroutines

function parseGo(text: string): Parsed {
  const lines = text.split("\n");
  const notes: string[] = [];
  const head = lines.findIndex((line) => GO.test(line));
  const match = /^(panic|fatal error): ([\s\S]*)$/.exec(lines[head]);
  const made = section("", null, 0);
  made.type = match?.[1] ?? "panic";
  made.message = (match?.[2] ?? "").replace(/ \[recovered\]$/, "");
  let index = head + 1;
  for (; index < lines.length && !/^goroutine \d+ \[/.test(lines[index]); index++) {
    const trimmed = lines[index].trim();
    if (trimmed === "") continue;
    if (/^\[signal /.test(trimmed)) notes.push(trimmed);
    else appendMessage(made, trimmed);
  }
  let goroutines = 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (/^goroutine \d+ \[/.test(line)) {
      goroutines++;
      if (goroutines === 1) notes.push(line.replace(/:$/, ""));
      continue;
    }
    if (/^exit status \d+$/.test(line.trim())) {
      notes.push(line.trim());
      continue;
    }
    if (goroutines !== 1 || line.trim() === "" || /^\s/.test(line)) continue;
    const next = lines[index + 1] ?? "";
    const location = /^\s+\S+:\d+/.test(next) ? stackFrame(next) : null;
    if (location !== null) index++;
    const fn = line.replace(/\((?:[^()]|\([^()]*\))*\)$/, "").replace(/ in goroutine \d+$/, "");
    const library = location === null || !location.app || /^runtime\./.test(fn);
    made.frames.push(frame(location === null ? line : `${line.trim()} ${next.trim()}`, fn, location, !library));
  }
  if (goroutines > 1) notes.push(`${goroutines - 1} other ${goroutines === 2 ? "goroutine" : "goroutines"}`);
  return { language: "go", sections: [made], notes, reversed: false };
}

// ---------------------------------------------------------------------------
// Rust: a panic, its message, and the backtrace when RUST_BACKTRACE is set

const RUST_HEAD = /^thread '([^']*)'(?: \(\d+\))? panicked at (?:'([\s\S]*?)', )?(\S+?:\d+:\d+):?\s*$/;
const RUST_RUNTIME = /^(?:<?(?:std|core|alloc|test|tokio|futures)::|<[^>]*\b(?:std|core|alloc)::|__rustc::|rust_begin_unwind|__rust_|_?start$|__libc_start|start_thread|_?main$|<unknown>$)/;

function parseRust(text: string): Parsed {
  const lines = text.split("\n");
  const notes: string[] = [];
  const head = lines.findIndex((line) => RUST.test(line));
  const match = RUST_HEAD.exec(lines[head]);
  const made = section("", null, 0);
  made.type = "panic";
  if (match !== null) {
    notes.push(`thread '${match[1]}'`);
    if (match[2] !== undefined) made.message = match[2];
  }
  let index = head + 1;
  for (; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed === "stack backtrace:") break;
    if (trimmed.startsWith("note: ")) notes.push(trimmed.slice(6));
    else if (trimmed !== "" && match?.[2] === undefined) appendMessage(made, trimmed);
  }
  // After the frames, Rust only says the backtrace is abridged (`RUST_BACKTRACE=full` prints more): nothing to show.
  for (index++; index < lines.length; index++) {
    const numbered = /^\s*\d+:\s+(.+)$/.exec(lines[index]);
    if (numbered === null) continue;
    const next = lines[index + 1] ?? "";
    const location = /^\s+at\s/.test(next) ? stackFrame(next) : null;
    if (location !== null) index++;
    const fn = numbered[1].trim();
    const app = !RUST_RUNTIME.test(fn) && (location === null || location.app);
    made.frames.push(frame(location === null ? fn : `${fn} ${next.trim()}`, fn, location, app));
  }
  if (made.frames.length === 0 && match !== null) {
    const location = stackFrame(`panicked at ${match[3]}`);
    made.frames.push(frame(match[3], null, location, location?.app ?? false));
  }
  return { language: "rust", sections: [made], notes, reversed: false };
}

// ---------------------------------------------------------------------------
// .NET: inner exceptions printed inside the outer one

const DOTNET_FRAME = /^at\s+(.+?)(?:\s+in\s+(.+):line\s+(\d+))?$/;
const DOTNET_RUNTIME = /^(?:System|Microsoft|Xunit|NUnit|Internal)\./;

function parseDotnet(text: string): Parsed {
  const sections: Section[] = [];
  const open: Section[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || /^--- End of stack trace from previous location/.test(trimmed)) continue;
    if (/^--- End of inner exception stack trace ---$/.test(trimmed)) {
      if (open.length > 1) open.pop();
      continue;
    }
    const inner = /^---> (.*)$/.exec(trimmed);
    if (inner !== null && open.length > 0) {
      const made = section(inner[1], "cause", 0);
      sections.push(made);
      open.push(made);
      continue;
    }
    const match = DOTNET_FRAME.exec(trimmed);
    const target = open[open.length - 1];
    if (match !== null && target !== undefined) {
      const location = match[2] === undefined ? null : stackFrame(line);
      const app = !DOTNET_RUNTIME.test(match[1]) && (location === null || location.app);
      target.frames.push(frame(trimmed, match[1], location, app));
      continue;
    }
    if (target === undefined) {
      const made = section(trimmed.replace(/^Unhandled exception\.\s*/, ""), null, 0);
      sections.push(made);
      open.push(made);
    } else if (target.frames.length === 0) appendMessage(target, trimmed);
  }
  return { language: "dotnet", sections, notes: [], reversed: false };
}

// ---------------------------------------------------------------------------
// Java, Kotlin, Scala

const JVM_AT = /^at\s+([\w$.<>/-]+)\((.*)\)$/;

function parseJava(text: string): Parsed {
  const sections: Section[] = [];
  const notes: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const tabs = /^\t*/.exec(line)![0].length;
    const target = sections[sections.length - 1];
    const at = JVM_AT.exec(trimmed);
    if (at !== null && target !== undefined) {
      const location = stackFrame(line);
      const app = location !== null ? location.app : !JVM_LIBRARY.test(at[1]) && at[2] !== "Native Method";
      target.frames.push(frame(trimmed, at[1], location, app));
      continue;
    }
    const more = /^\.\.\. (\d+) (?:more|common frames omitted)$/.exec(trimmed);
    if (more !== null) {
      if (target !== undefined) target.omitted += Number(more[1]);
      continue;
    }
    const linked = /^(Caused by|Suppressed): (.*)$/.exec(trimmed);
    if (linked !== null) {
      sections.push(section(linked[2], linked[1] === "Caused by" ? "cause" : "suppressed", tabs));
      continue;
    }
    if (target === undefined) {
      const thread = /^Exception in thread "([^"]*)" (.*)$/.exec(trimmed);
      if (thread !== null) notes.push(`thread "${thread[1]}"`);
      else if (/^(?:FATAL EXCEPTION|Process): /.test(trimmed)) {
        notes.push(trimmed);
        continue;
      }
      sections.push(section(thread?.[2] ?? trimmed, null, 0));
      continue;
    }
    if (target.frames.length === 0) appendMessage(target, trimmed);
  }
  return { language: "java", sections, notes, reversed: false };
}

// ---------------------------------------------------------------------------
// Ruby, Swift

const RUBY_FRAME = /^(?:from\s+)?(.+?):(\d+):in [`'](.*?)'(?::\s([\s\S]*))?$/;

function parseRuby(text: string): Parsed {
  const lines = text.split("\n");
  let made: Section | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = RUBY_FRAME.exec(trimmed);
    if (match === null) {
      if (made === null) made = section(trimmed, null, 0);
      else if (made.frames.length <= 1) appendMessage(made, trimmed);
      continue;
    }
    if (made === null) {
      // `app.rb:3:in 'm': divided by 0 (ZeroDivisionError)`: the first frame carries the error.
      const error = /^([\s\S]*?) \(([\w:]+)\)$/.exec(match[4] ?? "");
      made = section("", null, 0);
      made.type = error?.[2] ?? "";
      made.message = error?.[1] ?? match[4] ?? "";
    }
    const location = stackFrame(`${match[1]}:${match[2]}:in`);
    made.frames.push(frame(trimmed.replace(/:\s[\s\S]*$/, ""), match[3], location, location?.app ?? false));
  }
  return { language: "ruby", sections: made === null ? [] : [made], notes: [], reversed: false };
}

function parseSwift(text: string): Parsed {
  const sections: Section[] = [];
  const notes: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\S+?\.swift):(\d+): Fatal error: (.*)$/.exec(line.trim());
    if (match === null) {
      if (line.trim() !== "" && sections.length === 0) notes.push(line.trim());
      continue;
    }
    const made = section("", null, 0);
    made.type = "Fatal error";
    made.message = match[3];
    const location = stackFrame(`${match[1]}:${match[2]}`);
    made.frames.push(frame(`${match[1]}:${match[2]}`, null, location, location?.app ?? false));
    sections.push(made);
  }
  return { language: "swift", sections, notes, reversed: false };
}

// ---------------------------------------------------------------------------
// Reading a section

/** Frames and runs of 2+ consecutive library frames folded into one row. */
export type FrameRow = { readonly type: "frame"; readonly index: number } | { readonly type: "fold"; readonly start: number; readonly count: number };

export function frameRows(frames: readonly TraceFrame[], unfolded: ReadonlySet<number>): FrameRow[] {
  const rows: FrameRow[] = [];
  for (let index = 0; index < frames.length; ) {
    let end = index;
    while (end < frames.length && !frames[end].app) end++;
    if (end - index >= 2 && !unfolded.has(index)) {
      rows.push({ type: "fold", start: index, count: end - index });
      index = end;
    } else {
      const stop = Math.max(end, index + 1);
      for (; index < stop; index++) rows.push({ type: "frame", index });
    }
  }
  return rows;
}

/**
 * The file that holds a frame's code: its own path, or for a JVM frame (which
 * names only `Cls.java`) where Maven and Gradle keep its package's sources;
 * null for frames without one.
 */
export function sourcePath(f: TraceFrame): string | null {
  const location = f.location;
  if (location === null) return null;
  if (location.linkable) {
    if (!location.path.startsWith("file://")) return location.path;
    try {
      return decodeURI(location.path.slice(7));
    } catch {
      return location.path.slice(7);
    }
  }
  const parts = (f.fn ?? "").replace(/^[\w.]+\//, "").split(".");
  const cls = parts.findIndex((part) => /^[A-Z]/.test(part));
  if (cls <= 0) return null;
  return `src/main/${/\.kts?$/.test(location.path) ? "kotlin" : "java"}/${parts.slice(0, cls).join("/")}/${location.path}`;
}

export const LANGUAGE_NAMES: Readonly<Record<TraceLanguage, string>> = {
  javascript: "JavaScript",
  python: "Python",
  java: "JVM",
  go: "Go",
  rust: "Rust",
  dotnet: ".NET",
  ruby: "Ruby",
  swift: "Swift",
  text: "",
};

/** The line that introduces a section after the first: "Caused by", "While handling", "Error 2 of 3", "Suppressed". */
export function relationLabel(relation: TraceRelation | null, member: { readonly index: number; readonly count: number } | null): string {
  switch (relation) {
    case "cause":
      return "Caused by";
    case "context":
      return "While handling";
    case "suppressed":
      return "Suppressed";
    case "member":
      return member === null ? "Error" : `Error ${member.index} of ${member.count}`;
    default:
      return "";
  }
}

/** For each section, its place among its AggregateError's errors (null for others). */
export function memberPlaces(sections: readonly TraceSection[]): ({ readonly index: number; readonly count: number } | null)[] {
  const places: ({ index: number; count: number } | null)[] = sections.map(() => null);
  for (let index = 0; index < sections.length; index++) {
    if (sections[index].relation !== "member" || places[index] !== null) continue;
    const depth = sections[index].depth;
    const group: number[] = [];
    for (let at = index; at < sections.length && sections[at].depth >= depth; at++) {
      if (sections[at].depth === depth && sections[at].relation === "member") group.push(at);
    }
    group.forEach((at, position) => (places[at] = { index: position + 1, count: group.length }));
  }
  return places;
}
