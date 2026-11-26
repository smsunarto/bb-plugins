interface MarkdownDocument {
  frontmatter: string;
  body: string;
  title: string | null;
}

interface MarkdownLine {
  start: number;
  nextStart: number;
  text: string;
}

function readLine(content: string, start: number): MarkdownLine {
  const newline = content.indexOf("\n", start);
  const end = newline === -1 ? content.length : newline;
  const textEnd = end > start && content[end - 1] === "\r" ? end - 1 : end;
  return {
    start,
    nextStart: newline === -1 ? content.length : newline + 1,
    text: content.slice(start, textEnd),
  };
}

const NON_STRING_PLAIN_SCALAR =
  /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|[+-]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

const BLOCK_SCALAR_HEADER = /^[|>](?:[+-]?\d|\d[+-]?|[+-])?(?:\s+#.*|\s*)$/;
const FLOW_BRACKETS = /[[\]{}]/;

function isInlineCommentStart(text: string, index: number): boolean {
  return (
    text[index] === "#" && (index === 0 || text[index - 1] === " " || text[index - 1] === "\t")
  );
}

function stripInlineComment(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (isInlineCommentStart(value, i)) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseSingleQuoted(raw: string): { value: string; rest: string } | null {
  let out = "";
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] !== "'") {
      out += raw[i];
      continue;
    }
    if (raw[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    return { value: out, rest: raw.slice(i + 1) };
  }
  return null;
}

function parseDoubleQuoted(raw: string): { value: string; rest: string } | null {
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch !== '"') continue;
    try {
      const parsed: unknown = JSON.parse(raw.slice(0, i + 1));
      return typeof parsed === "string" ? { value: parsed, rest: raw.slice(i + 1) } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseQuotedString(raw: string): { value: string; rest: string } | null {
  if (raw[0] === "'") return parseSingleQuoted(raw);
  if (raw[0] === '"') return parseDoubleQuoted(raw);
  return null;
}

function trailingIsCommentOrEmpty(rest: string): boolean {
  const trimmed = rest.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

interface FlowState {
  stack: string[];
  quote: "'" | '"' | null;
}

function advanceQuotedChar(text: string, index: number, state: FlowState): number {
  const ch = text[index];
  if (state.quote === "'") {
    if (ch !== "'") return index;
    if (text[index + 1] === "'") return index + 1;
    state.quote = null;
    return index;
  }
  if (ch === "\\") return index + 1;
  if (ch === '"') state.quote = null;
  return index;
}

function scanFlowStep(text: string, state: FlowState): boolean {
  for (let i = 0; i < text.length; i++) {
    if (state.quote !== null) {
      i = advanceQuotedChar(text, i, state);
      continue;
    }
    if (isInlineCommentStart(text, i)) break;
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      state.quote = ch;
    } else if (ch === "[" || ch === "{") {
      state.stack.push(ch === "[" ? "]" : "}");
    } else if (ch === "]" || ch === "}") {
      if (state.stack.pop() !== ch) return false;
    }
  }
  return true;
}

function parseMappingEntry(trimmed: string): { key: string; rawValue: string } | null {
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    const parsed = parseQuotedString(trimmed);
    if (!parsed) return null;
    const afterKey = parsed.rest.trimStart();
    if (!afterKey.startsWith(":")) return null;
    const afterColon = afterKey.slice(1);
    if (afterColon.length > 0 && afterColon[0] !== " " && afterColon[0] !== "\t") return null;
    return { key: parsed.value, rawValue: afterColon.trimStart() };
  }
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ":") continue;
    const next = trimmed[i + 1];
    if (next !== undefined && next !== " " && next !== "\t") continue;
    const key = trimmed.slice(0, i).trim();
    return key ? { key, rawValue: trimmed.slice(i + 1).trimStart() } : null;
  }
  return null;
}

interface ParserState {
  title: string | null;
  hasEntry: boolean;
  baseIndent: number | null;
  blockScalar: { indent: number; style: "|" | ">"; isTitle: boolean; lines: string[] } | null;
  flow: FlowState;
}

function flushBlockScalar(state: ParserState): void {
  const block = state.blockScalar;
  if (!block) return;
  if (block.isTitle) {
    const joined =
      block.style === ">"
        ? block.lines.map((line) => line.trim()).join(" ")
        : block.lines.join("\n");
    const trimmed = joined.trim();
    state.title = trimmed || null;
  }
  state.blockScalar = null;
}

function isSequenceItem(trimmed: string): boolean {
  return trimmed === "-" || trimmed.startsWith("- ");
}

function setTitle(state: ParserState, key: string, value: string | null): void {
  if (key === "title") state.title = value;
}

function applyMappingValue(
  state: ParserState,
  indent: number,
  key: string,
  rawValue: string,
): boolean {
  if (rawValue === "" || rawValue.startsWith("#")) {
    setTitle(state, key, null);
    return true;
  }
  if (BLOCK_SCALAR_HEADER.test(rawValue)) {
    state.blockScalar = {
      indent,
      style: rawValue[0] as "|" | ">",
      isTitle: key === "title",
      lines: [],
    };
    return true;
  }
  const first = rawValue[0];
  if (first === "'" || first === '"') {
    const parsed = parseQuotedString(rawValue);
    if (!parsed || !trailingIsCommentOrEmpty(parsed.rest)) return false;
    setTitle(state, key, parsed.value.trim() || null);
    return true;
  }
  if (first === "[" || first === "{") {
    if (!scanFlowStep(rawValue, state.flow)) return false;
    setTitle(state, key, null);
    return true;
  }
  const plain = stripInlineComment(rawValue);
  setTitle(state, key, plain && !NON_STRING_PLAIN_SCALAR.test(plain) ? plain : null);
  return true;
}

function consumeBlockScalarLine(
  state: ParserState,
  line: string,
  trimmed: string,
  indent: number,
): boolean {
  if (!state.blockScalar) return false;
  if (trimmed === "" || indent > state.blockScalar.indent) {
    state.blockScalar.lines.push(trimmed === "" ? "" : line.slice(state.blockScalar.indent + 1));
    return true;
  }
  flushBlockScalar(state);
  return false;
}

function initRootLine(state: ParserState, trimmed: string, indent: number): boolean | null {
  if (isSequenceItem(trimmed) || trimmed.startsWith("[")) return false;
  state.baseIndent = indent;
  if (!trimmed.startsWith("{")) return null;
  state.hasEntry = true;
  return scanFlowStep(trimmed, state.flow);
}

function processLine(state: ParserState, line: string): boolean {
  const trimmed = line.trim();
  const indent = line.length - line.trimStart().length;

  if (consumeBlockScalarLine(state, line, trimmed, indent)) return true;
  if (state.flow.stack.length > 0 || state.flow.quote !== null) {
    return scanFlowStep(line, state.flow);
  }
  if (trimmed === "" || trimmed.startsWith("#")) return true;

  if (state.baseIndent === null) {
    const initResult = initRootLine(state, trimmed, indent);
    if (initResult !== null) return initResult;
  }
  const baseIndent = state.baseIndent!;
  if (indent > baseIndent) {
    return state.hasEntry && (!FLOW_BRACKETS.test(trimmed) || scanFlowStep(trimmed, state.flow));
  }
  if (indent < baseIndent || isSequenceItem(trimmed)) return false;

  const entry = parseMappingEntry(trimmed);
  if (!entry) return false;
  state.hasEntry = true;
  return applyMappingValue(state, indent, entry.key, entry.rawValue);
}

function parseFrontmatterMetadata(source: string): { title: string | null } | null {
  const state: ParserState = {
    title: null,
    hasEntry: false,
    baseIndent: null,
    blockScalar: null,
    flow: { stack: [], quote: null },
  };
  for (const line of source.split(/\r?\n/)) {
    if (!processLine(state, line)) return null;
  }
  flushBlockScalar(state);
  if (state.flow.stack.length > 0 || state.flow.quote !== null) return null;
  return { title: state.title };
}

export function parseMarkdownDocument(content: string): MarkdownDocument {
  const firstLineStart = content.startsWith("\uFEFF") ? 1 : 0;
  const firstLine = readLine(content, firstLineStart);
  if (firstLine.text !== "---") {
    return { frontmatter: "", body: content, title: null };
  }

  let lineStart = firstLine.nextStart;
  while (lineStart < content.length) {
    const line = readLine(content, lineStart);
    if (line.text === "---" || line.text === "...") {
      const frontmatterSource = content.slice(firstLine.nextStart, line.start);
      const metadata = parseFrontmatterMetadata(frontmatterSource);
      if (!metadata) break;
      return {
        frontmatter: content.slice(0, line.nextStart),
        body: content.slice(line.nextStart),
        title: metadata.title,
      };
    }
    if (line.nextStart === lineStart) break;
    lineStart = line.nextStart;
  }

  return { frontmatter: "", body: content, title: null };
}
