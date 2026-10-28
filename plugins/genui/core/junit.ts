// JUnit XML, the report pytest --junitxml, gotestsum, cargo-nextest,
// Maven/Gradle, jest-junit and vitest's junit reporter write, read into the
// list `Tests` takes. The XML reader is deliberately small and strict: no
// DOCTYPE (so no entity declarations and nothing to expand), only the five
// predefined entities and character references, every tag closed in order.
// It reads the text in one pass with indexOf, and its output is never longer
// than its input, so the data loader's size limit bounds the work.
import { LIMITS } from "./catalog";
import type { Value } from "./types";

/** A reason the file is not a readable JUnit report, already phrased for the user. */
export class JUnitError extends Error {}

interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: XmlElement[];
  /** Character data directly inside the element (CDATA included), concatenated. */
  text: string;
}

/** Elements nested deeper than this are refused; real reports nest a handful. */
const MAX_DEPTH = 64;

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const ATTRIBUTE = /\s+([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;
const PREDEFINED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** 1-based line of `index` in `text`, for messages. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line++;
  return line;
}

/** Character and predefined entity references resolved; anything else is an error. */
function decode(raw: string, source: string, start: number): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&\s]*);?/g, (match, body: string, offset: number) => {
    const fail = (message: string): never => {
      throw new JUnitError(`line ${lineAt(source, start + offset)}: ${message}`);
    };
    if (!match.endsWith(";")) fail('a "&" that starts no entity (write &amp;)');
    if (Object.hasOwn(PREDEFINED, body)) return PREDEFINED[body];
    const numeric = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (numeric === null) return fail(`the entity &${body}; is not one XML predefines`);
    const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : Number(numeric[2]);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail(`&${body}; is not a character`);
    return String.fromCodePoint(code);
  });
}

/** Parses an XML document into its root element. Throws JUnitError with a line number. */
export function parseXml(source: string): XmlElement {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let index = 0;
  const fail = (message: string, at = index): never => {
    throw new JUnitError(`line ${lineAt(text, at)}: ${message}`);
  };
  /** Skips past `terminator`, which must exist after `index`. */
  const skipPast = (terminator: string, what: string) => {
    const end = text.indexOf(terminator, index);
    if (end === -1) fail(`${what} never closes`);
    index = end + terminator.length;
  };

  while (index < text.length) {
    const open = text.indexOf("<", index);
    const chunkEnd = open === -1 ? text.length : open;
    if (chunkEnd > index) {
      const chunk = text.slice(index, chunkEnd);
      const current = stack[stack.length - 1];
      if (current === undefined) {
        if (chunk.trim() !== "") fail(root === null ? "text before the root element" : "text after the root element");
      } else {
        current.text += decode(chunk, text, index);
      }
      index = chunkEnd;
      if (open === -1) break;
    }

    if (text.startsWith("<!--", index)) {
      skipPast("-->", "a comment");
    } else if (text.startsWith("<![CDATA[", index)) {
      const current = stack[stack.length - 1];
      if (current === undefined) fail("CDATA outside an element");
      const start = index + 9;
      const end = text.indexOf("]]>", start);
      if (end === -1) fail("a CDATA section never closes");
      current!.text += text.slice(start, end);
      index = end + 3;
    } else if (text.startsWith("<!", index)) {
      // DOCTYPE and other declarations: refusing them refuses entity declarations, so nothing can expand.
      fail("DOCTYPE and other declarations are not read; a JUnit report needs none");
    } else if (text.startsWith("<?", index)) {
      skipPast("?>", "a processing instruction");
    } else if (text.startsWith("</", index)) {
      NAME.lastIndex = index + 2;
      const name = NAME.exec(text)?.[0];
      if (name === undefined) fail("a closing tag without a name");
      const current = stack.pop();
      if (current === undefined) fail(`</${name}> closes nothing`);
      if (current!.name !== name) fail(`</${name}> closes <${current!.name}>`);
      const close = /\s*>/y;
      close.lastIndex = index + 2 + name!.length;
      if (close.exec(text) === null) fail(`</${name}> is malformed`);
      index = close.lastIndex;
    } else {
      NAME.lastIndex = index + 1;
      const name = NAME.exec(text)?.[0];
      if (name === undefined) fail('a "<" that starts no tag (write &lt;)');
      let at = index + 1 + name!.length;
      const attributes = new Map<string, string>();
      for (;;) {
        ATTRIBUTE.lastIndex = at;
        const attribute = ATTRIBUTE.exec(text);
        if (attribute === null) break;
        const [, key, , doubleQuoted, singleQuoted] = attribute;
        if (attributes.has(key)) fail(`<${name}> repeats the attribute ${key}`, at);
        const raw = doubleQuoted ?? singleQuoted;
        attributes.set(key, decode(raw, text, at + attribute[0].indexOf(raw)));
        at = ATTRIBUTE.lastIndex;
      }
      TAG_END.lastIndex = at;
      const end = TAG_END.exec(text);
      if (end === null) fail(`<${name}> is malformed`, at);
      if (stack.length === 0 && root !== null) fail("a second root element");
      if (stack.length >= MAX_DEPTH) fail(`elements are nested more than ${MAX_DEPTH} deep`);
      const element: XmlElement = { name: name!, attributes, children: [], text: "" };
      if (stack.length === 0) root = element;
      else stack[stack.length - 1].children.push(element);
      if (end![1] !== "/") stack.push(element);
      index = TAG_END.lastIndex;
    }
  }
  if (stack.length > 0) fail(`<${stack[stack.length - 1].name}> never closes`, text.length);
  if (root === null) throw new JUnitError("the file has no XML element");
  return root;
}

/** One test as `Tests` takes it; optional fields are absent rather than null. */
type TestRecord = Record<string, Value>;

interface SuiteContext {
  readonly name: string | null;
  readonly file: string | null;
}

function attribute(element: XmlElement, name: string): string | null {
  const value = element.attributes.get(name)?.trim();
  return value === undefined || value === "" ? null : value;
}

/** JUnit `time` is seconds; tests take milliseconds, rounded to a hundredth. */
function milliseconds(element: XmlElement): number | null {
  const time = attribute(element, "time");
  if (time === null) return null;
  const seconds = Number(time.replace(/,/g, ""));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 100_000) / 100 : null;
}

/** A failure or error: its message attribute and its body (usually the trace), without repeating the message. */
function problemText(element: XmlElement): string | null {
  const message = attribute(element, "message");
  const type = attribute(element, "type");
  const body = element.text.replace(/^\s*\n|\s+$/g, "");
  if (body.trim() === "") return message ?? type;
  if (message === null || body.includes(message)) return body;
  return `${message}\n\n${body}`;
}

function testRecord(testcase: XmlElement, suite: SuiteContext): TestRecord {
  const name = attribute(testcase, "name") ?? attribute(testcase, "classname") ?? "(unnamed test)";
  const problem = testcase.children.find((child) => child.name === "failure" || child.name === "error");
  const skipped = testcase.children.find((child) => child.name === "skipped");
  const status = problem !== undefined ? (problem.name === "error" ? "error" : "failed") : skipped !== undefined ? "skipped" : "passed";
  const record: TestRecord = { name, status };
  const suiteName = attribute(testcase, "classname") ?? suite.name;
  if (suiteName !== null) record.suite = suiteName;
  const file = attribute(testcase, "file") ?? suite.file;
  if (file !== null) record.file = file;
  const line = Number(attribute(testcase, "line"));
  if (Number.isSafeInteger(line) && line > 0) record.line = line;
  const ms = milliseconds(testcase);
  if (ms !== null) record.ms = ms;
  const message = problem !== undefined ? problemText(problem) : skipped !== undefined ? problemText(skipped) : null;
  if (message !== null) record.message = message;
  // Captured output matters next to a failure; for passing tests it is noise the value would carry for nothing.
  if (problem !== undefined) {
    const output = testcase.children
      .filter((child) => child.name === "system-out" || child.name === "system-err")
      .map((child) => child.text.trim())
      .filter((text) => text !== "")
      .join("\n");
    if (output !== "") record.output = output;
  }
  return record;
}

/**
 * The tests of a JUnit report (`<testsuites>` or a lone `<testsuite>`), in
 * document order. A report with more tests than one list may hold comes back
 * as suites instead, `[{suite, tests: [...]}]`, each within the list limit,
 * which `Tests` reads the same way.
 */
export function readJUnit(source: string): Value {
  const root = parseXml(source);
  if (root.name !== "testsuites" && root.name !== "testsuite") {
    throw new JUnitError(`only JUnit test reports are read from .xml files; this one's root is <${root.name}>, not <testsuites> or <testsuite>`);
  }
  const tests: { readonly suite: string; readonly record: TestRecord }[] = [];
  const pending: { readonly element: XmlElement; readonly context: SuiteContext }[] = [
    { element: root, context: { name: null, file: null } },
  ];
  // Depth-first in document order, without recursion.
  while (pending.length > 0) {
    const { element, context } = pending.pop()!;
    const inner: SuiteContext =
      element.name === "testsuite"
        ? { name: attribute(element, "name") ?? context.name, file: attribute(element, "file") ?? context.file }
        : context;
    for (let at = element.children.length - 1; at >= 0; at--) {
      const child = element.children[at];
      if (child.name === "testsuite") pending.push({ element: child, context: inner });
      else if (child.name === "testcase") pending.push({ element: child, context: inner });
    }
    if (element.name === "testcase") {
      const record = testRecord(element, context);
      tests.push({ suite: typeof record.suite === "string" ? record.suite : (context.name ?? "Tests"), record });
    }
  }
  if (tests.length <= LIMITS.listLength) return tests.map(({ record }) => record);

  const groups: { suite: string; tests: TestRecord[] }[] = [];
  const open = new Map<string, { suite: string; tests: TestRecord[] }>();
  for (const { suite, record } of tests) {
    let group = open.get(suite);
    if (group === undefined || group.tests.length >= LIMITS.listLength) {
      group = { suite, tests: [] };
      open.set(suite, group);
      groups.push(group);
    }
    group.tests.push(record);
  }
  if (groups.length > LIMITS.listLength) {
    throw new JUnitError(`the report has ${tests.length} tests in ${groups.length} suites; the limit is ${LIMITS.listLength} suites`);
  }
  return groups;
}
