// What `Tests` shows, from the three shapes it takes: a plain list
// (`[{name, status, message?, file?, line?, ms?}]`, which is also what a
// JUnit `.xml` Load reads into), a vitest or jest JSON reporter object, and
// the suites a very large JUnit report becomes. Also the pieces of a failure
// message the renderer and the markdown fallback share: ANSI colour codes and
// stack frames. Pure: no React, no DOM.
import type { Value } from "./types";

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestCase {
  readonly name: string;
  readonly status: TestStatus;
  /** The reporter's own word where it says more than the status: "error", "todo", "pending", "xfail". */
  readonly detail: string | null;
  /** The describe block, class or module; for JS reports the file. */
  readonly suite: string | null;
  readonly file: string | null;
  readonly line: number | null;
  readonly ms: number | null;
  readonly message: string | null;
  /** Captured stdout/stderr, kept for failures. */
  readonly output: string | null;
}

export interface TestRun {
  readonly tests: readonly TestCase[];
  readonly counts: Readonly<Record<TestStatus, number>>;
  /** The whole run in ms: the report's wall clock where it has one, else the tests' sum; null when nothing is timed. */
  readonly ms: number | null;
  /** List items that were not tests (no name, or no status a test can have). */
  readonly ignored: number;
}

export type TestRunResult = { readonly ok: true; readonly run: TestRun } | { readonly ok: false; readonly error: string };

/** A plain data object's fields; absent keys read as undefined. */
type Fields = Readonly<Record<string, Value | undefined>>;

function isList(value: Value | undefined): value is readonly Value[] {
  return Array.isArray(value);
}

/** `value` as a plain data object, or null for scalars, lists and the interpreter's node/action/binding shapes. */
function fieldsOf(value: Value | undefined): Fields | null {
  if (typeof value !== "object" || value === null || isList(value)) return null;
  if ("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding")) return null;
  // Only plain data objects are left; TypeScript cannot drop the interpreter's interfaces by a `kind` an index signature also has.
  const fields = value as Fields;
  return fields;
}

function str(value: Value | undefined): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: Value | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function positiveInteger(value: Value | undefined): number | null {
  const n = num(value);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
}

const STATUS_WORDS: Readonly<Record<string, readonly [TestStatus, string | null]>> = {
  pass: ["passed", null],
  passed: ["passed", null],
  passing: ["passed", null],
  ok: ["passed", null],
  success: ["passed", null],
  succeeded: ["passed", null],
  successful: ["passed", null],
  xpass: ["passed", "xpass"],
  xpassed: ["passed", "xpass"],
  // jest: a `.only` test, which ran and passed.
  focused: ["passed", null],
  fail: ["failed", null],
  failed: ["failed", null],
  failing: ["failed", null],
  failure: ["failed", null],
  error: ["failed", "error"],
  errored: ["failed", "error"],
  broken: ["failed", "broken"],
  crashed: ["failed", "crashed"],
  timedout: ["failed", "timed out"],
  timeout: ["failed", "timed out"],
  skip: ["skipped", null],
  skipped: ["skipped", null],
  pending: ["skipped", "pending"],
  todo: ["skipped", "todo"],
  disabled: ["skipped", "disabled"],
  ignored: ["skipped", "ignored"],
  excluded: ["skipped", "excluded"],
  xfail: ["skipped", "xfail"],
  xfailed: ["skipped", "xfail"],
};

/** A status word as a status, its detail kept when it says more; null when it is no test status. */
export function testStatus(value: Value | undefined): { readonly status: TestStatus; readonly detail: string | null } | null {
  if (typeof value === "boolean") return { status: value ? "passed" : "failed", detail: null };
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!Object.hasOwn(STATUS_WORDS, word)) return null;
  const [status, detail] = STATUS_WORDS[word];
  return { status, detail };
}

/** `a.ts:12` or `a.ts:12:3` → path and line; anything else is all path. */
function splitLocation(raw: string): { readonly file: string; readonly line: number | null } {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  return match === null || match[1] === "" ? { file: raw, line: null } : { file: match[1], line: Number(match[2]) };
}

/** An error value as text: a string, a list of strings, or `{stack|message}`. */
function errorText(value: Value | undefined): string | null {
  if (typeof value === "string") return str(value);
  if (Array.isArray(value)) {
    const parts = value.map(errorText).filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join("\n\n");
  }
  const error = fieldsOf(value);
  return error === null ? null : (str(error.stack) ?? str(error.message));
}

/** One test from a plain list item; null when it is not one. */
function listTest(value: Value, group: { suite: string | null; file: string | null }): TestCase | null {
  const item = fieldsOf(value);
  if (item === null) return null;
  const name = str(item.name) ?? str(item.title) ?? str(item.fullName) ?? str(item.test);
  const status = testStatus(item.status ?? item.state ?? item.outcome ?? item.result ?? item.ok ?? item.passed);
  if (name === null || status === null) return null;
  const location = str(item.file) ?? str(item.path) ?? (typeof item.location === "string" ? str(item.location) : null);
  const split = location === null ? null : splitLocation(location);
  const locationLine = positiveInteger(fieldsOf(item.location)?.line);
  return {
    name,
    status: status.status,
    detail: status.detail,
    suite: str(item.suite) ?? str(item.classname) ?? str(item.describe) ?? group.suite,
    file: split?.file ?? group.file,
    line: positiveInteger(item.line) ?? split?.line ?? locationLine,
    ms: num(item.ms) ?? num(item.duration) ?? num(item.durationMs),
    message: errorText(item.message) ?? errorText(item.error) ?? errorText(item.failureMessages) ?? errorText(item.failureMessage),
    output: str(item.output) ?? str(item.stdout),
  };
}

function fromList(items: readonly Value[]): { tests: TestCase[]; ignored: number } {
  const tests: TestCase[] = [];
  let ignored = 0;
  for (const item of items) {
    // A group: `{suite|name|file, tests: [...]}` (what a very large JUnit report becomes).
    const fields = fieldsOf(item);
    if (fields !== null && Array.isArray(fields.tests)) {
      const file = str(fields.file);
      const group = { suite: str(fields.suite) ?? str(fields.name) ?? file, file };
      for (const test of fields.tests) {
        const read = listTest(test, group);
        if (read === null) ignored++;
        else tests.push(read);
      }
      continue;
    }
    const read = listTest(item, { suite: null, file: null });
    if (read === null) ignored++;
    else tests.push(read);
  }
  return { tests, ignored };
}

/** vitest's and jest's JSON reporter: `testResults[]` per file, each with `assertionResults[]`. */
function fromJestReport(report: Fields): { tests: TestCase[]; ms: number | null } {
  const tests: TestCase[] = [];
  let earliest = num(report.startTime);
  let latest: number | null = null;
  let fileTime = 0;
  for (const entry of Array.isArray(report.testResults) ? report.testResults : []) {
    const result = fieldsOf(entry);
    if (result === null) continue;
    const file = str(result.name) ?? str(result.testFilePath);
    const start = num(result.startTime);
    const end = num(result.endTime);
    if (start !== null && end !== null && end >= start) {
      fileTime += end - start;
      earliest = earliest === null ? start : Math.min(earliest, start);
      latest = latest === null ? end : Math.max(latest, end);
    }
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    let failed = false;
    for (const entry of assertions) {
      const assertion = fieldsOf(entry);
      if (assertion === null) continue;
      const status = testStatus(assertion.status);
      const title = str(assertion.title);
      const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles.map(str).filter((t) => t !== null) : [];
      const name = title !== null && ancestors.length > 0 ? [...ancestors, title].join(" › ") : (title ?? str(assertion.fullName));
      if (status === null || name === null) continue;
      failed ||= status.status === "failed";
      tests.push({
        name,
        status: status.status,
        detail: status.detail,
        suite: file,
        file,
        line: positiveInteger(fieldsOf(assertion.location)?.line),
        ms: num(assertion.duration),
        message: errorText(assertion.failureMessages) ?? errorText(assertion.failureDetails),
        output: null,
      });
    }
    // A file that failed to load (syntax error, failing hook) has a message and no failed test to carry it.
    const message = str(result.message) ?? str(result.failureMessage);
    if (!failed && message !== null && (result.status === "failed" || assertions.length === 0)) {
      tests.push({ name: "(the file failed to run)", status: "failed", detail: null, suite: file, file, line: null, ms: null, message, output: null });
    }
  }
  const wall = earliest !== null && latest !== null && latest >= earliest ? latest - earliest : null;
  return { tests, ms: wall ?? (fileTime > 0 ? fileTime : null) };
}

const SHAPE_HINT = "Tests needs a list of {name, status}, a vitest/jest JSON report or a JUnit XML report";

/** The run `value` describes, failures located by their stack where the report gives no line. */
export function readTestRun(value: Value | undefined): TestRunResult {
  let tests: TestCase[];
  let ms: number | null = null;
  let ignored = 0;
  if (Array.isArray(value)) {
    ({ tests, ignored } = fromList(value));
    if (tests.length === 0 && value.length > 0) return { ok: false, error: "Tests items need a name and a status (passed, failed or skipped)" };
  } else {
    const report = fieldsOf(value);
    if (report !== null && Array.isArray(report.testResults)) ({ tests, ms } = fromJestReport(report));
    else if (report !== null && Array.isArray(report.tests)) ({ tests, ignored } = fromList(report.tests));
    else return { ok: false, error: SHAPE_HINT };
  }
  const located = tests.map(locate);
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let sum = 0;
  let timed = false;
  for (const test of located) {
    counts[test.status]++;
    if (test.ms !== null) {
      sum += test.ms;
      timed = true;
    }
  }
  return { ok: true, run: { tests: located, counts, ms: ms ?? (timed ? sum : null), ignored } };
}

/** A failure without a line takes it from its first app frame in the test's file (or any app frame when the test names no file). */
function locate(test: TestCase): TestCase {
  if (test.status !== "failed" || test.line !== null || test.message === null) return test;
  const frame = firstAppFrame(stripAnsi(test.message).split("\n"));
  if (frame === null || !frame.linkable) return test;
  if (test.file === null) return { ...test, file: frame.path, line: frame.line };
  return samePath(test.file, frame.path) ? { ...test, line: frame.line } : test;
}

function samePath(a: string, b: string): boolean {
  const x = a.replace(/^file:\/\//, "").replace(/^\.\//, "");
  const y = b.replace(/^file:\/\//, "").replace(/^\.\//, "");
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// ---------------------------------------------------------------------------
// Grouping

export interface TestGroup {
  /** The suite or file the tests share; "Tests" when they name neither. */
  readonly label: string;
  readonly file: string | null;
  readonly tests: readonly TestCase[];
  readonly counts: Readonly<Record<TestStatus, number>>;
  readonly ms: number | null;
}

/** Tests grouped by suite (else file), in order of first appearance. */
export function groupTests(tests: readonly TestCase[]): TestGroup[] {
  const groups = new Map<string, { label: string; file: string | null; tests: TestCase[] }>();
  for (const test of tests) {
    const label = test.suite ?? test.file ?? "Tests";
    let group = groups.get(label);
    if (group === undefined) {
      group = { label, file: test.file, tests: [] };
      groups.set(label, group);
    } else if (group.file !== test.file) {
      group.file = null;
    }
    group.tests.push(test);
  }
  return [...groups.values()].map((group) => {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    let ms: number | null = null;
    for (const test of group.tests) {
      counts[test.status]++;
      if (test.ms !== null) ms = (ms ?? 0) + test.ms;
    }
    return { ...group, counts, ms };
  });
}

/** "3 failed, 45 passed, 2 skipped": failures first, zero counts left out, "no tests" when empty. */
export function countsText(counts: Readonly<Record<TestStatus, number>>): string {
  const parts = (["failed", "passed", "skipped"] as const).filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${status}`);
  return parts.length === 0 ? "no tests" : parts.join(", ");
}

/** `0.4 ms`, `12 ms`, `1.24 s`, `14.2 s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1) return ms <= 0 ? "0 ms" : `${Math.round(ms * 10) / 10} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${rest}s`;
}

// ---------------------------------------------------------------------------
// ANSI colour codes

export type AnsiColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "dim";

export interface AnsiSegment {
  readonly text: string;
  readonly color: AnsiColor | null;
  readonly bold: boolean;
  /** Reverse video, which jest uses to mark the changed characters of a diff. */
  readonly inverse: boolean;
}

/** CSI sequences (colours, cursor moves, erases), OSC sequences (titles, links) and lone two-byte escapes. */
const ESCAPE = /(?:\x1b\[|\x9b)([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]?/g;

const BASIC: readonly (AnsiColor | null)[] = ["dim", "red", "green", "yellow", "blue", "magenta", "cyan", null];

export function stripAnsi(text: string): string {
  return text.includes("\x1b") || text.includes("\x9b") ? text.replace(ESCAPE, "") : text;
}

/** `text` split at its SGR colour codes into styled runs; every other escape is dropped. */
export function ansiSegments(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let color: AnsiColor | null = null;
  let bold = false;
  let inverse = false;
  let dim = false;
  let last = 0;
  const push = (end: number) => {
    if (end > last) {
      const piece = text.slice(last, end);
      const style = { color: color ?? (dim ? "dim" : null), bold, inverse };
      const previous = segments[segments.length - 1];
      if (previous !== undefined && previous.color === style.color && previous.bold === bold && previous.inverse === inverse) {
        segments[segments.length - 1] = { ...previous, text: previous.text + piece };
      } else {
        segments.push({ text: piece, ...style });
      }
    }
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(match.index);
    last = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] ?? "").split(";").map((code) => (code === "" ? 0 : Number(code)));
    for (let at = 0; at < codes.length; at++) {
      const code = codes[at];
      if (code === 0) {
        color = null;
        bold = dim = inverse = false;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) bold = dim = false;
      else if (code === 7) inverse = true;
      else if (code === 27) inverse = false;
      else if (code >= 30 && code <= 37) color = BASIC[code - 30];
      else if (code >= 90 && code <= 97) color = BASIC[code - 90];
      else if (code === 39) color = null;
      else if (code === 38 || code === 48) {
        // 38;5;n and 38;2;r;g;b: the 16 basic indexes keep their colour; the rest read as plain text.
        const mode = codes[at + 1];
        if (code === 38 && mode === 5) {
          const index = codes[at + 2];
          color = index !== undefined && index < 16 ? BASIC[index % 8] : null;
        } else if (code === 38) {
          color = null;
        }
        at += mode === 5 ? 2 : mode === 2 ? 4 : 1;
      }
    }
  }
  push(text.length);
  return segments;
}

/** ansiSegments cut into lines, each line keeping the style that was open across the break. */
export function ansiLines(text: string): AnsiSegment[][] {
  const lines: AnsiSegment[][] = [[]];
  for (const segment of ansiSegments(text)) {
    const parts = segment.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1].push({ ...segment, text: part.replace(/\r$/, "") });
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Stack frames

export interface StackFrame {
  /** As the trace wrote it (absolute, relative or `file://`). */
  readonly path: string;
  readonly line: number;
  readonly column: number | null;
  /** Not a dependency, the runtime or the test runner: the code under test or the test itself. */
  readonly app: boolean;
  /** False for frames that name only a file (Java's `Foo.java:12`), which no workspace path matches. */
  readonly linkable: boolean;
}

/** The file extensions a trace or log names source files by (a regex alternation). */
export const CODE_EXTENSIONS = "[cm]?[jt]sx?|py|go|rs|rb|php|cs|swift|kt|kts|java|scala|ex|exs|erl|c|cc|cpp|cxx|h|hpp|m|mm|dart|lua|vue|svelte|astro";

const FRAME_PATTERNS: readonly RegExp[] = [
  // V8 `at fn (path:1:2)` / `at path:1:2`; vitest's ` ❯ path:1:2`
  new RegExp(`^\\s*(?:at|❯)\\s+(?:.*?\\s\\(|.*?\\s)?((?:file:\\/\\/)?[^\\s()]+?\\.(?:${CODE_EXTENSIONS})):(\\d+)(?::(\\d+))?\\)?\\s*$`),
  // Python `File "path", line 12, in fn`
  /^\s*File "([^"]+)", line (\d+)()/,
  // C# `at Ns.Type.Method() in /path/File.cs:line 42`
  /\sin\s(\S.*?\.cs):line (\d+)()/,
  // Rust `--> src/lib.rs:12:5`, `panicked at src/lib.rs:12:5:`
  /(?:-->|panicked at)\s+(\S+?\.rs):(\d+)(?::(\d+))?/,
  // Firefox and Safari `fn@/abs/a.js:1:2` / `fn@file:///abs/a.js:1:2`
  new RegExp(`^\\s*[^\\s@]*@((?:file:\\/\\/)?\\/[^\\s@]*?\\.(?:${CODE_EXTENSIONS})):(\\d+)(?::(\\d+))?\\s*$`),
  // pytest `tests/test_api.py:22: AssertionError`, go `  foo_test.go:12: msg`, go frames, ruby `from app.rb:3:in 'm'`, `path:1:2` lines
  new RegExp(`^\\s*(?:from\\s+)?((?:file:\\/\\/)?[^\\s:"'()]+\\.(?:${CODE_EXTENSIONS})):(\\d+)(?::(\\d+))?(?=$|[:\\s])`),
];

/**
 * A script served by a dev server or a bundler, in a browser trace: V8's
 * `at fn (http://localhost:5173/src/a.ts?t=1:12:5)`, Firefox and Safari's
 * `fn@http://…/a.js:1:2`, webpack's `webpack-internal:///./src/a.tsx:3:4`.
 * The URL's path is the file's path in the app (Vite's `/@fs/` marks an absolute one).
 */
const URL_FRAME = new RegExp(
  `(?:^\\s*at\\s+(?:.*?\\s\\()?|^\\s*[^\\s@]*@)(?:https?:\\/\\/[^\\s/()]+|webpack(?:-internal)?:\\/\\/[^\\s/()]*)(\\/[^\\s()?#]*?\\.(?:${CODE_EXTENSIONS}))(?:[?#][^\\s()]*?)?:(\\d+)(?::(\\d+))?\\)?\\s*$`,
);

function servedPath(urlPath: string): string {
  const path = decodeURIComponentSafe(urlPath);
  return path.startsWith("/@fs/") ? path.slice(4) : path.slice(1);
}

/** Java/Kotlin/Scala `at pkg.Cls.method(Cls.java:12)`: only a file name. */
const JVM_FRAME = /^\s*at\s+([\w$.<>/]+)\(([\w$.-]+\.(?:java|kt|kts|scala|groovy|clj)):(\d+)\)/;
/** The JDK, the JVM languages' runtimes, test runners and the frameworks and drivers most traces pass through. */
export const JVM_LIBRARY =
  /^(?:[\w.]+\/)?(?:java|javax|jakarta|jdk|sun|com\.sun|kotlin|kotlinx|scala|org\.junit|junit|org\.testng|org\.opentest4j|org\.apache|org\.gradle|org\.spockframework|io\.kotest|org\.springframework|org\.hibernate|org\.postgresql|com\.mysql|com\.zaxxer|io\.netty|io\.micrometer|reactor|okhttp3|retrofit2|com\.fasterxml|com\.google|org\.eclipse|org\.jboss|io\.undertow|android|androidx|dalvik|com\.android)\./;

const LIBRARY_PATH =
  /node_modules\/|^node:|^internal\/|\(internal\/|<anonymous>|<frozen |\/site-packages\/|\/dist-packages\/|\/lib\/python\d|(?:^|\/)_pytest\/|(?:^|\/)pluggy\/|^\/rustc\/|\/rustlib\/|\/\.cargo\/registry\/|\/\.rustup\/|\/go\/src\/|\/libexec\/src\/|\/pkg\/mod\/|^\/usr\/(?:lib|local\/lib|share)\/|\/gems\/|\/lib\/ruby\/|^Swift\//;

/** The frame a line of a trace names, or null. */
export function stackFrame(line: string): StackFrame | null {
  const jvm = JVM_FRAME.exec(line);
  if (jvm !== null) {
    return { path: jvm[2], line: Number(jvm[3]), column: null, app: !JVM_LIBRARY.test(jvm[1]), linkable: false };
  }
  const served = URL_FRAME.exec(line);
  const match = served ?? FRAME_PATTERNS.reduce<RegExpExecArray | null>((found, pattern) => found ?? pattern.exec(line), null);
  if (match === null) return null;
  const lineNumber = Number(match[2]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  const path = served === null ? match[1] : servedPath(match[1]);
  return {
    path,
    line: lineNumber,
    column: match[3] ? Number(match[3]) : null,
    app: !LIBRARY_PATH.test(path),
    linkable: true,
  };
}

/** A trace line that is no part of the code under test: a dependency's or runtime's frame, or V8's `at new Promise (<anonymous>)`. */
export function libraryFrame(line: string): boolean {
  const frame = stackFrame(line);
  if (frame !== null) return !frame.app;
  return /^\s*at\s.*(?:<anonymous>|\(native\)|\(index \d+\)|\bnode:)|@\[native code\]\s*$/.test(line);
}

/** The first frame in `lines` that is the code under test (not a dependency or the runner), with its line index. */
export function firstAppFrame(lines: readonly string[]): (StackFrame & { readonly index: number }) | null {
  for (let index = 0; index < lines.length; index++) {
    const frame = stackFrame(lines[index]);
    if (frame?.app) return { ...frame, index };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paths

/**
 * The workspace-relative path BB can open for a path from a report, or null:
 * `file://` and `./` dropped, absolute paths made relative to `root` (null
 * outside it or without a root), `..` refused.
 */
export function workspacePath(path: string, root: string | null): string | null {
  let target = path.startsWith("file://") ? decodeURIComponentSafe(path.slice(7)) : path;
  if (target.startsWith("/")) {
    if (root === null) return null;
    const base = root.endsWith("/") ? root : `${root}/`;
    if (!target.startsWith(base)) return null;
    target = target.slice(base.length);
  }
  target = target.replace(/^(?:\.\/)+/, "");
  if (target === "" || target.includes("\\") || target.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return target;
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The longest directory (ending in `/`) every absolute path in `paths` starts with; "" when there is none. */
export function commonDirectory(paths: Iterable<string>): string {
  let common: string | null = null;
  for (const path of paths) {
    if (!path.startsWith("/")) continue;
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    if (common === null) {
      common = directory;
      continue;
    }
    let length = 0;
    while (length < common.length && length < directory.length && common[length] === directory[length]) length++;
    common = common.slice(0, common.lastIndexOf("/", length - 1) + 1);
  }
  return common ?? "";
}

/** A path as shown: relative to `root` when inside it, else with `common` (see commonDirectory) cut off. */
export function displayPath(path: string, root: string | null, common: string): string {
  const relative = workspacePath(path, root);
  if (relative !== null) return relative;
  const plain = path.startsWith("file://") ? decodeURIComponentSafe(path.slice(7)) : path;
  return common !== "" && plain.startsWith(common) && plain.length > common.length ? plain.slice(common.length) : plain;
}
