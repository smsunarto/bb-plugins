// check_ui for ```app pages. An app runs in a sandboxed frame with no network
// and no dialogs, so the usual ways a page breaks there are visible in its
// source: a script that doesn't parse (top-level await in a classic script,
// a typo), anything that reaches for the network (CDN scripts and styles,
// fetch, remote images), dialogs that show nothing, genui calls made outside
// the click that allows them, and 100vh layouts in a frame sized to its
// content. This reads the page; it never runs it. Server only (node:vm).
import vm from "node:vm";
import { formatDiagnostics } from "./index";
import type { Diagnostic } from "./types";

/** check_ui's cap for an app page (a ```ui spec has its own, smaller one). */
export const MAX_APP_CHARS = 100_000;

const NO_NETWORK = "apps have no network";
const INLINE = "Inline the code you need in a <script>.";

/** Script types the browser runs as classic scripts. */
const CLASSIC_TYPES: Record<string, true> = {
  "": true,
  "text/javascript": true,
  "application/javascript": true,
  "application/ecmascript": true,
  "text/ecmascript": true,
  "application/x-javascript": true,
};

/** Elements whose src (or href, for SVG <image>) loads a file. */
const MEDIA_TAGS: Record<string, true> = { img: true, video: true, audio: true, source: true, iframe: true, embed: true, track: true, image: true };

const REMOTE = /^\s*(?:https?:|\/\/)/i;
const LOCAL_URL = /^\s*(?:data:|blob:|#|$)/i;

/** The page's problems, in source order, with 1-based lines and columns in `html`. */
export function lintApp(html: string): Diagnostic[] {
  const findings: Array<Diagnostic & { offset: number }> = [];
  const starts = lineStarts(html);
  const report = (offset: number, severity: Diagnostic["severity"], message: string) => {
    const { line, column } = position(starts, offset);
    findings.push({ offset, severity, line, column, message });
  };
  // Comments hide their tags from the browser, so they do from the scan too.
  const page = html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, " "));
  const tag = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
  for (let match = tag.exec(page); match !== null; match = tag.exec(page)) {
    const name = match[1].toLowerCase();
    const attributes = readAttributes(match[2], match.index + 1 + match[1].length);
    const attribute = (key: string) => attributes.find((candidate) => candidate.name === key);
    for (const { name: key, value, offset } of attributes) {
      if (key.startsWith("on")) scanCode(decodeEntities(value), offset, "handler", report);
      if (key === "style") scanCss(value, offset, report);
    }
    if (name === "script" || name === "style") {
      const contentStart = match.index + match[0].length;
      const close = page.slice(contentStart).search(name === "script" ? /<\/script\s*>/i : /<\/style\s*>/i);
      const contentEnd = close === -1 ? page.length : contentStart + close;
      const content = page.slice(contentStart, contentEnd);
      tag.lastIndex = contentEnd;
      if (name === "style") {
        scanCss(content, contentStart, report);
        continue;
      }
      const src = attribute("src");
      if (src !== undefined) report(src.offset, "error", `<script src="${src.value}"> can't load: ${NO_NETWORK}. ${INLINE}`);
      const type = (attribute("type")?.value ?? "").trim().toLowerCase();
      if (type === "module") {
        scanCode(content, contentStart, "module", report);
      } else if (type === "importmap") {
        if (/["'](?:https?:|\/\/)/i.test(content)) report(contentStart, "error", `an import map can't load modules: ${NO_NETWORK}. ${INLINE}`);
      } else if (Object.hasOwn(CLASSIC_TYPES, type) && src === undefined) {
        checkSyntax(content, contentStart, starts, report);
        scanCode(content, contentStart, "classic", report);
      }
      continue;
    }
    if (name === "link") {
      const href = attribute("href");
      if (href !== undefined && !LOCAL_URL.test(href.value)) {
        report(href.offset, "error", `<link href="${href.value}"> can't load: ${NO_NETWORK}. Put CSS in a <style> element; fonts come from var(--font-sans).`);
      }
    } else if (Object.hasOwn(MEDIA_TAGS, name)) {
      for (const key of ["src", "poster", "href", "xlink:href"]) {
        const url = attribute(key);
        if (url !== undefined && REMOTE.test(url.value)) {
          report(url.offset, "error", `<${name} ${key}="${url.value}"> can't load: ${NO_NETWORK}. Draw it (SVG, canvas) or embed it as a data: URL.`);
        }
      }
    }
    if (name === "a") {
      const href = attribute("href")?.value.trim();
      if (href !== undefined && href !== "" && !href.startsWith("#") && !/^https:/i.test(href) && !/^javascript:/i.test(href)) {
        report(attribute("href")!.offset, "warning", `<a href="${href}"> opens nothing from an app: only https links open, in BB.`);
      }
    }
  }
  return findings
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset: _offset, ...finding }) => finding);
}

/** check_ui's report for an app: what to fix, or a plain statement that nothing was found. */
export function checkApp(html: string): { readonly ok: boolean; readonly report: string } {
  if (html.length > MAX_APP_CHARS) {
    return { ok: false, report: `The app has ${html.length} characters; check_ui reads up to ${MAX_APP_CHARS}.` };
  }
  const findings = lintApp(html);
  if (findings.length === 0) {
    return {
      ok: true,
      report:
        "No errors or warnings in the app. Checked: script syntax, network use, dialogs, genui calls outside a handler, 100vh heights. check_ui reads the page; it doesn't run it.",
    };
  }
  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    report: `Fix before replying (lines are the app's):\n${formatDiagnostics(findings)}`,
  };
}

type Report = (offset: number, severity: Diagnostic["severity"], message: string) => void;

/**
 * Compiles a classic script without running it. V8 reports the first syntax
 * error; the script's position in the page is passed as its offset so the
 * error's line is the page's.
 */
function checkSyntax(code: string, offset: number, starts: readonly number[], report: Report) {
  const { line, column } = position(starts, offset);
  try {
    new vm.Script(code, { filename: "app.html", lineOffset: line - 1, columnOffset: column - 1 });
  } catch (error) {
    if (!(error instanceof SyntaxError)) return;
    // Top-level await shows up as other errors too (`await (…)` reads as a
    // call), so: if there is an await outside any function and the code
    // parses as an async function's body, that await is the error.
    const tokens = tokenizeJs(code);
    const inside = trackFunctions(tokens);
    const awaited = tokens.findIndex((token, at) => token.type === "name" && token.value === "await" && !inside[at]);
    if (awaited !== -1 && parsesAsAsyncBody(code)) {
      report(
        offset + tokens[awaited].start,
        "error",
        "script doesn't parse: classic scripts have no top-level await. Put the code in an async function and call it.",
      );
      return;
    }
    const stack = String(error.stack ?? "").split("\n");
    const errorLine = Number(/^app\.html:(\d+)/.exec(stack[0] ?? "")?.[1] ?? line);
    const caret = (stack[2] ?? "").indexOf("^");
    const errorColumn = caret === -1 ? 1 : caret + 1 + (errorLine === line ? column - 1 : 0);
    const start = starts[Math.min(Math.max(errorLine - 1, 0), starts.length - 1)] + errorColumn - 1;
    let message = `script doesn't parse: ${error.message}`;
    if (/import statement outside a module/.test(error.message)) message += `. Apps load no modules: ${INLINE.toLowerCase()}`;
    report(Math.max(start, offset), "error", message);
  }
}

function parsesAsAsyncBody(code: string): boolean {
  try {
    new vm.Script(`(async function () {\n${code}\n})`);
    return true;
  } catch {
    return false;
  }
}

/** CSS in a <style> element or a style attribute. */
function scanCss(css: string, offset: number, report: Report) {
  for (const match of css.matchAll(/@import\b\s*(?:url\(\s*)?["']?([^"')\s;]*)/gi)) {
    if (!/^data:/i.test(match[1])) report(offset + match.index, "error", `@import ${match[1]} can't load: ${NO_NETWORK}. Put the CSS in this <style>.`);
  }
  for (const match of css.matchAll(/(?<![\w-])(?<!@import\s*)url\(\s*["']?((?:https?:)?\/\/[^"')\s]*)/gi)) {
    report(offset + match.index, "error", `url(${match[1]}) can't load: ${NO_NETWORK}. Use a data: URL, a gradient or inline SVG.`);
  }
  for (const match of css.matchAll(/(?<![\w-])(?:min-)?height\s*:\s*100[dsl]?vh\b/gi)) {
    report(
      offset + match.index,
      "warning",
      `${match[0].replace(/\s+/g, " ")} never settles: the frame sizes itself to the page. Let the content set the height, or use a px height.`,
    );
  }
}

/** Calls that only work when a click, key or change handler is running. */
const GESTURE_CALLS: Record<string, true> = { answer: true, openLink: true };
/** Globals a bare call or reference resolves to (also reached through these). */
const GLOBAL_OBJECTS: Record<string, true> = { window: true, self: true, globalThis: true };

const DIALOGS: Record<string, string> = {
  alert: "alert() shows nothing in an app. Draw the message in the page (a status line or a panel).",
  confirm: "confirm() returns false without asking in an app. Draw the question in the page with buttons.",
  prompt: "prompt() returns null without asking in an app. Put an <input> in the page.",
};

/**
 * Network use, dialogs, indexedDB, module imports and genui calls made at
 * the top level, from the script's tokens (so comments and strings don't
 * count). `kind` "handler" is an on* attribute: it runs inside its event.
 */
function scanCode(code: string, offset: number, kind: "classic" | "module" | "handler", report: Report) {
  const tokens = tokenizeJs(code);
  const scopes = trackFunctions(tokens);
  const at = (token: Token) => offset + token.start;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "name") continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const member = previous?.value === "." || previous?.value === "?.";
    // `fetch(…)` or `window.fetch(…)`, not `cache.fetch(…)`.
    const global = !member || Object.hasOwn(GLOBAL_OBJECTS, tokens[index - 2]?.value ?? "");
    const called = next?.value === "(";
    const word = token.value;
    // `function fetch(…) {` and a method `fetch(…) {` define the name rather than call the global.
    const defines = previous?.value === "function" || (called && tokens[closingParen(tokens, index + 1) + 1]?.value === "{");
    if (global && !defines) {
      if (word === "fetch" && called) report(at(token), "error", `fetch() can't reach anything: ${NO_NETWORK}. Put the data in the page.`);
      else if (word === "XMLHttpRequest" || word === "WebSocket" || word === "EventSource") {
        report(at(token), "error", `${word} can't connect: ${NO_NETWORK}. Put the data in the page.`);
      } else if (Object.hasOwn(DIALOGS, word) && called) report(at(token), "warning", DIALOGS[word]);
      else if (word === "indexedDB") report(at(token), "warning", "indexedDB is unavailable in apps. Use localStorage (saved with the block, up to 256 KB).");
    }
    if (word === "sendBeacon" && member) report(at(token), "error", `sendBeacon() can't send: ${NO_NETWORK}.`);
    if (word === "open" && member && called && Object.hasOwn(GLOBAL_OBJECTS, tokens[index - 2]?.value ?? "")) {
      report(at(token), "warning", "window.open() opens nothing from an app. Call genui.openLink(url) (https) in a click handler instead.");
    }
    if (word === "import" && !member) {
      if (called) {
        const argument = tokens[index + 2];
        const literal = argument?.type === "string" ? argument.text : undefined;
        if (literal === undefined || !/^(?:data|blob):/i.test(literal)) {
          report(at(token), "error", `import(${literal === undefined ? "…" : JSON.stringify(literal)}) can't load: ${NO_NETWORK}. ${INLINE}`);
        }
      } else if (kind === "module" && next?.type === "string") {
        reportImport(next, at(next), report);
      }
    }
    // `import a from "x"`, `import * as a from "x"`, `export { a } from "x"`.
    if (word === "from" && kind === "module" && next?.type === "string" && (previous?.type === "name" || previous?.value === "}" || previous?.value === "*")) {
      reportImport(next, at(next), report);
    }
    if (word === "genui" && !member && kind !== "handler" && next?.value === "." && Object.hasOwn(GESTURE_CALLS, tokens[index + 2]?.value ?? "")) {
      if (tokens[index + 3]?.value === "(" && !scopes[index]) {
        const call = `genui.${tokens[index + 2].value}()`;
        report(at(token), "warning", `${call} runs at the script's top level, outside a user gesture, so it does nothing. Call it in a click, key or change handler.`);
      }
    }
  }
}

/** The index of the `)` that closes the `(` at `open`, or the last token's when it never closes. */
function closingParen(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    else if (tokens[index].value === ")" && --depth === 0) return index;
  }
  return tokens.length - 1;
}

function reportImport(specifier: Token, offset: number, report: Report) {
  const name = specifier.text ?? "";
  if (/^(?:data|blob):/i.test(name)) return;
  const why = REMOTE.test(name) ? NO_NETWORK : "apps have no network or import map, so it doesn't resolve";
  report(offset, "error", `import ${JSON.stringify(name)} can't load: ${why}. ${INLINE}`);
}

interface Token {
  readonly type: "name" | "punct" | "string" | "template" | "regex" | "number";
  readonly value: string;
  /** A string literal's contents (escapes left as written). */
  readonly text?: string;
  readonly start: number;
  /** A line break comes between this token and the one before. */
  readonly newline: boolean;
}

/** Keywords after which `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX: Record<string, true> = {
  return: true,
  typeof: true,
  instanceof: true,
  in: true,
  of: true,
  new: true,
  delete: true,
  void: true,
  throw: true,
  case: true,
  do: true,
  else: true,
  yield: true,
  await: true,
};

/**
 * A forgiving JS tokenizer: enough to tell code from strings, comments and
 * regular expressions, and to follow brackets. Never throws; unterminated
 * literals run to the end.
 */
function tokenizeJs(code: string): Token[] {
  const tokens: Token[] = [];
  /** Open `${` in template literals: the brace depth inside each. */
  const templates: number[] = [];
  let index = 0;
  let newline = false;
  const push = (type: Token["type"], start: number, text?: string) => {
    tokens.push({ type, value: code.slice(start, index), text, start, newline });
    newline = false;
  };
  /** Reads template text from `index` up to its closing backtick or a `${`. */
  const templateChunk = (start: number) => {
    while (index < code.length) {
      const char = code[index];
      if (char === "\\") index += 2;
      else if (char === "`") {
        index += 1;
        break;
      } else if (char === "$" && code[index + 1] === "{") {
        index += 2;
        templates.push(0);
        break;
      } else index += 1;
    }
    push("template", start);
  };
  while (index < code.length) {
    const char = code[index];
    const start = index;
    if (char === "\n") {
      newline = true;
      index += 1;
    } else if (/\s/.test(char)) {
      index += 1;
    } else if (char === "/" && code[index + 1] === "/") {
      while (index < code.length && code[index] !== "\n") index += 1;
    } else if (char === "/" && code[index + 1] === "*") {
      const end = code.indexOf("*/", index + 2);
      const stop = end === -1 ? code.length : end + 2;
      if (code.slice(index, stop).includes("\n")) newline = true;
      index = stop;
    } else if (char === '"' || char === "'") {
      index += 1;
      while (index < code.length && code[index] !== char && code[index] !== "\n") index += code[index] === "\\" ? 2 : 1;
      const text = code.slice(start + 1, Math.min(index, code.length));
      index += 1;
      push("string", start, text);
    } else if (char === "`") {
      index += 1;
      templateChunk(start);
    } else if (char === "}" && templates.length > 0 && templates[templates.length - 1] === 0) {
      templates.pop();
      index += 1;
      templateChunk(start);
    } else if (/[A-Za-z_$#\u0080-\uffff]/.test(char)) {
      index += 1;
      while (index < code.length && /[\w$\u0080-\uffff]/.test(code[index])) index += 1;
      push("name", start);
    } else if (/\d/.test(char) || (char === "." && /\d/.test(code[index + 1] ?? ""))) {
      index += 1;
      while (index < code.length && /[\w.]/.test(code[index])) index += 1;
      push("number", start);
    } else if (char === "/" && startsRegex(tokens[tokens.length - 1])) {
      index += 1;
      let inClass = false;
      while (index < code.length && code[index] !== "\n") {
        const next = code[index];
        if (next === "\\") index += 1;
        else if (next === "[") inClass = true;
        else if (next === "]") inClass = false;
        else if (next === "/" && !inClass) break;
        index += 1;
      }
      index += 1;
      while (index < code.length && /\w/.test(code[index])) index += 1;
      push("regex", start);
    } else {
      const three = code.slice(index, index + 3);
      const two = code.slice(index, index + 2);
      index += three === "..." ? 3 : two === "=>" || (two === "?." && !/\d/.test(code[index + 2] ?? "")) ? 2 : 1;
      if (templates.length > 0) {
        if (char === "{") templates[templates.length - 1] += 1;
        else if (char === "}") templates[templates.length - 1] -= 1;
      }
      push("punct", start);
    }
  }
  return tokens;
}

function startsRegex(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.type === "name") return Object.hasOwn(BEFORE_REGEX, previous.value);
  if (previous.type === "punct") return ![")", "]", "}"].includes(previous.value);
  return false;
}

/** Statements whose `(…) {` opens a block, not a function body. */
const BLOCK_HEADS: Record<string, true> = { if: true, for: true, while: true, switch: true, catch: true, with: true };

/**
 * For each token, whether it sits inside a function: a `function` or method
 * body, an arrow's block, or an arrow's expression (which ends at a `,` or
 * `;` at its own depth, a closing bracket, or a new statement on a new line).
 */
function trackFunctions(tokens: readonly Token[]): boolean[] {
  type Open = { readonly kind: "(" | "[" | "{" | "=>"; readonly fn: boolean; readonly head?: Token };
  const stack: Open[] = [];
  const inside: boolean[] = [];
  let functions = 0;
  /** The token before the `(` that the last `)` closed. */
  let lastHead: Token | undefined;
  const pop = () => {
    const open = stack.pop();
    if (open?.fn) functions -= 1;
    return open;
  };
  const endArrows = () => {
    while (stack.length > 0 && stack[stack.length - 1].kind === "=>") pop();
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    // Without semicolons, a line that starts a new statement ends an arrow's expression.
    const complete = previous !== undefined && (previous.type !== "punct" || previous.value === ")" || previous.value === "]");
    const starts = (token.type === "name" && !Object.hasOwn(BEFORE_REGEX, token.value)) || token.type === "string";
    if (token.newline && stack[stack.length - 1]?.kind === "=>" && complete && starts) endArrows();
    inside.push(functions > 0);
    const value = token.type === "punct" ? token.value : "";
    if (value === "(" || value === "[") {
      stack.push({ kind: value, fn: false, head: previous });
    } else if (value === "{") {
      const fn =
        previous?.value === "=>" ||
        (previous?.value === ")" && lastHead !== undefined && (lastHead.value === "function" || lastHead.value === "*" || (lastHead.type === "name" && !Object.hasOwn(BLOCK_HEADS, lastHead.value))));
      stack.push({ kind: "{", fn });
      if (fn) functions += 1;
    } else if (value === ")" || value === "]" || value === "}") {
      endArrows();
      const open = pop();
      if (value === ")") lastHead = open?.head;
    } else if (value === "=>") {
      if (tokens[index + 1]?.value !== "{") {
        stack.push({ kind: "=>", fn: true });
        functions += 1;
      }
    } else if (value === "," || value === ";") {
      endArrows();
    }
  }
  return inside;
}

function readAttributes(source: string, offset: number): Array<{ name: string; value: string; offset: number }> {
  const attributes: Array<{ name: string; value: string; offset: number }> = [];
  for (const match of source.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    const valueAt = match[4] !== undefined ? match[0].length - value.length : match[0].length - value.length - (match[2] !== undefined || match[3] !== undefined ? 1 : 0);
    attributes.push({ name: match[1].toLowerCase(), value, offset: offset + match.index + valueAt });
  }
  return attributes;
}

/** Entities that commonly appear in handler attributes; anything else stays as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" };
    const lower = entity.toLowerCase();
    if (named[lower] !== undefined) return named[lower];
    const code = lower.startsWith("&#x") ? parseInt(lower.slice(3), 16) : parseInt(lower.slice(2), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function position(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}
