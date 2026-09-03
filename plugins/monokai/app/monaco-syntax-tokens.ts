import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const ACTIVE_PROPERTY = "--bb-monokai-active";
const MONOKAI_CANVAS = "#181818";
const MONOKAI_INK = "#e3e3dd";
const ACTIVE_MOUNT = Symbol.for("bb.monokai.monaco-syntax-tokens.active-mount");
const EDITOR_STYLESHEET = /\/editor\.css(?:[?#].*)?$/;
const MAX_SOURCE_LENGTH = 1_000_000;
const MAX_SEMANTIC_TOKENS = 20_000;

const SEMANTIC_SCOPES = [
  "storage.type",
  "entity.name.function",
  "entity.name.function.declaration",
  "variable.parameter",
  "variable.parameter.reference",
  "entity.name.type",
] as const;

type SemanticScope = (typeof SEMANTIC_SCOPES)[number];

export interface SyntaxToken {
  line: number;
  start: number;
  length: number;
  scope: SemanticScope;
}

interface LexicalToken {
  offset: number;
  type: string;
}

interface CssPropertyReader {
  getPropertyValue(property: string): string;
}

interface SourceToken {
  value: string;
  line: number;
  start: number;
  length: number;
}

interface Disposable {
  dispose(): void;
}

interface MonacoModel {
  getLanguageId(): string;
  getValue(): string;
  getVersionId(): number;
}

interface MonacoEditor {
  getRawOptions(): { "semanticHighlighting.enabled"?: true | false | "configuredByTheme" };
  updateOptions(options: {
    "semanticHighlighting.enabled": true | false | "configuredByTheme";
  }): void;
}

interface MonacoRuntime {
  editor: {
    getEditors(): readonly MonacoEditor[];
    onDidCreateEditor(listener: (editor: MonacoEditor) => void): Disposable;
    tokenize(source: string, languageId: string): LexicalToken[][];
  };
  languages: {
    registerDocumentSemanticTokensProvider(
      languageId: string,
      provider: MonacoSemanticTokensProvider,
    ): Disposable;
  };
}

interface MonacoSemanticTokensProvider {
  getLegend(): { tokenTypes: readonly string[]; tokenModifiers: readonly string[] };
  provideDocumentSemanticTokens(
    model: MonacoModel,
    lastResultId: string | null,
    cancellation: { isCancellationRequested: boolean },
  ): { resultId: string; data: Uint32Array };
  releaseDocumentSemanticTokens(resultId: string | undefined): void;
}

interface MonacoModule {
  monaco?: MonacoRuntime;
}

export interface MonacoSyntaxDependencies {
  findModuleUrls: () => string[];
  importModule: (url: string) => Promise<MonacoModule>;
  isThemeActive: () => boolean;
  mountFallback: () => () => void;
  observe: (listener: () => void) => () => void;
}

type MountRegistry = typeof globalThis & {
  [ACTIVE_MOUNT]?: () => void;
};

const WORD = /^[A-Za-z_$][\w$]*$/;
const CAPITALIZED = /^[A-Z][A-Za-z0-9_$]*$/;
const DECLARATION_KEYWORDS = new Set([
  "class",
  "const",
  "enum",
  "function",
  "interface",
  "let",
  "type",
  "var",
]);
const NON_CALL_WORDS = new Set([
  "catch",
  "class",
  "do",
  "else",
  "for",
  "function",
  "if",
  "import",
  "new",
  "return",
  "switch",
  "throw",
  "typeof",
  "while",
  "with",
]);
const TYPE_WORDS = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "number",
  "object",
  "string",
  "symbol",
  "unknown",
  "void",
]);
const PARAMETER_MODIFIERS = new Set(["private", "protected", "public", "readonly"]);
const REGEXP_PREFIXES = new Set([
  "(",
  "[",
  "{",
  ",",
  ":",
  ";",
  "=",
  "=>",
  "!",
  "&&",
  "||",
  "?",
  "return",
  "case",
  "throw",
]);

function isWord(token: SourceToken | undefined): token is SourceToken {
  return token !== undefined && WORD.test(token.value);
}

function lexicalTypeAt(
  lexicalLines: readonly (readonly LexicalToken[])[] | undefined,
  line: number,
  start: number,
): string | null {
  const tokens = lexicalLines?.[line];
  if (tokens === undefined || tokens.length === 0) return null;
  let type = tokens[0]?.type ?? null;
  for (const token of tokens) {
    if (token.offset > start) break;
    type = token.type;
  }
  return type;
}

function isBlockedLexicalType(type: string | null): boolean {
  return type !== null && /^(comment|string|regexp)(?:\.|$)/.test(type);
}

export function isMonokaiThemeActive(style: CssPropertyReader): boolean {
  const value = (property: string) => style.getPropertyValue(property).trim().toLowerCase();
  return (
    value(ACTIVE_PROPERTY) === "1" ||
    (value("--canvas") === MONOKAI_CANVAS && value("--ink") === MONOKAI_INK)
  );
}

function scanSource(
  source: string,
  lexicalLines?: readonly (readonly LexicalToken[])[],
): SourceToken[] {
  const tokens: SourceToken[] = [];
  let offset = 0;
  let line = 0;
  let column = 0;

  const advance = () => {
    if (source[offset] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
    offset += 1;
  };

  const skipQuoted = (quote: string) => {
    advance();
    while (offset < source.length) {
      if (source[offset] === "\\") {
        advance();
        if (offset < source.length) advance();
        continue;
      }
      const current = source[offset];
      advance();
      if (current === quote) return;
    }
  };

  while (offset < source.length) {
    const current = source[offset] ?? "";
    const next = source[offset + 1] ?? "";
    if (/\s/.test(current)) {
      advance();
      continue;
    }
    if (current === "/" && next === "/") {
      while (offset < source.length && source[offset] !== "\n") advance();
      continue;
    }
    if (current === "/" && next === "*") {
      advance();
      advance();
      while (offset < source.length && !(source[offset] === "*" && source[offset + 1] === "/")) {
        advance();
      }
      if (offset < source.length) {
        advance();
        advance();
      }
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      skipQuoted(current);
      continue;
    }
    if (
      current === "/" &&
      next !== "=" &&
      (tokens.length === 0 || REGEXP_PREFIXES.has(tokens.at(-1)?.value ?? ""))
    ) {
      advance();
      let inCharacterClass = false;
      while (offset < source.length) {
        if (source[offset] === "\\") {
          advance();
          if (offset < source.length) advance();
          continue;
        }
        if (source[offset] === "[") inCharacterClass = true;
        if (source[offset] === "]") inCharacterClass = false;
        if (source[offset] === "/" && !inCharacterClass) {
          advance();
          while (/[a-z]/i.test(source[offset] ?? "")) advance();
          break;
        }
        advance();
      }
      continue;
    }

    const tokenLine = line;
    const tokenStart = column;
    const tokenOffset = offset;
    if (/[A-Za-z_$]/.test(current)) {
      advance();
      while (/[A-Za-z0-9_$]/.test(source[offset] ?? "")) advance();
    } else {
      const pair = source.slice(offset, offset + 2);
      if (["=>", "?.", "&&", "||", "==", "!=", "<=", ">=", "++", "--"].includes(pair)) {
        advance();
        advance();
      } else {
        advance();
      }
    }
    if (isBlockedLexicalType(lexicalTypeAt(lexicalLines, tokenLine, tokenStart))) continue;
    tokens.push({
      value: source.slice(tokenOffset, offset),
      line: tokenLine,
      start: tokenStart,
      length: offset - tokenOffset,
    });
  }
  return tokens;
}

function matchingPairs(
  tokens: readonly SourceToken[],
  open: string,
  close: string,
): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) stack.push(index);
    if (tokens[index]?.value !== close) continue;
    const start = stack.pop();
    if (start !== undefined) pairs.set(start, index);
  }
  return pairs;
}

function findParameterNames(tokens: readonly SourceToken[], start: number, end: number): number[] {
  const names: number[] = [];
  let segmentStart = start;
  let depth = 0;
  const addSegment = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      const token = tokens[index];
      if (!isWord(token) || PARAMETER_MODIFIERS.has(token.value)) continue;
      names.push(index);
      return;
    }
  };
  for (let index = start; index <= end; index += 1) {
    const value = tokens[index]?.value;
    if (value === "(" || value === "[" || value === "{") depth += 1;
    if (value === ")" || value === "]" || value === "}") depth -= 1;
    if ((value === "," && depth === 0) || index === end) {
      addSegment(segmentStart, value === "," ? index : index + 1);
      segmentStart = index + 1;
    }
  }
  return names;
}

function callParenAfter(tokens: readonly SourceToken[], index: number): number | null {
  const next = tokens[index + 1];
  if (next?.value === "(") return index + 1;
  if (next?.value !== "<") return null;
  let depth = 0;
  for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 80); cursor += 1) {
    const value = tokens[cursor]?.value;
    if (value === "<") depth += 1;
    if (value === ">") depth -= 1;
    if (depth === 0) return tokens[cursor + 1]?.value === "(" ? cursor + 1 : null;
  }
  return null;
}

function bodyRangeAfter(
  tokens: readonly SourceToken[],
  closeParen: number,
  bracePairs: ReadonlyMap<number, number>,
): { start: number; end: number } | null {
  const first = tokens[closeParen + 1]?.value;
  if (first === "=>") {
    const bodyStart = closeParen + 2;
    if (tokens[bodyStart]?.value === "{") {
      const end = bracePairs.get(bodyStart);
      return end === undefined ? null : { start: bodyStart + 1, end };
    }
    let end = bodyStart;
    while (end < tokens.length && ![",", ";"].includes(tokens[end]?.value ?? "")) end += 1;
    return { start: bodyStart, end };
  }
  if (first === "{") {
    const end = bracePairs.get(closeParen + 1);
    return end === undefined ? null : { start: closeParen + 2, end };
  }
  if (first !== ":") return null;

  for (let index = closeParen + 2; index < Math.min(tokens.length, closeParen + 120); index += 1) {
    const value = tokens[index]?.value;
    if (value === "{") {
      const end = bracePairs.get(index);
      return end === undefined ? null : { start: index + 1, end };
    }
    if (value === ";" || value === "=") return null;
  }
  return null;
}

export function syntaxTokensForSource(
  source: string,
  lexicalLines?: readonly (readonly LexicalToken[])[],
): SyntaxToken[] {
  if (source.length > MAX_SOURCE_LENGTH) return [];
  const tokens = scanSource(source, lexicalLines);
  const parenPairs = matchingPairs(tokens, "(", ")");
  const bracePairs = matchingPairs(tokens, "{", "}");
  const scopeByIndex = new Map<number, SemanticScope>();
  const declarationFunctionIndexes = new Set<number>();
  const parameterRegions: Array<{ names: Set<string>; start: number; end: number }> = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (DECLARATION_KEYWORDS.has(token.value)) scopeByIndex.set(index, "storage.type");

    if (token.value === "function") {
      let openParen = index + 1;
      let foundName = false;
      while (openParen < tokens.length && tokens[openParen]?.value !== "(") {
        if (!foundName && isWord(tokens[openParen]) && tokens[openParen]?.value !== "async") {
          declarationFunctionIndexes.add(openParen);
          foundName = true;
        }
        openParen += 1;
      }
      const closeParen = parenPairs.get(openParen);
      if (closeParen === undefined) continue;
      const parameterIndexes = findParameterNames(tokens, openParen + 1, closeParen - 1);
      for (const parameterIndex of parameterIndexes) {
        scopeByIndex.set(parameterIndex, "variable.parameter");
      }
      const body = bodyRangeAfter(tokens, closeParen, bracePairs);
      if (body !== null) {
        parameterRegions.push({
          names: new Set(
            parameterIndexes.map((parameterIndex) => tokens[parameterIndex]?.value ?? ""),
          ),
          ...body,
        });
      }
    }
  }

  for (const [openParen, closeParen] of parenPairs) {
    const after = tokens[closeParen + 1]?.value;
    const before = tokens[openParen - 1];
    const arrow = after === "=>";
    const method =
      isWord(before) &&
      !NON_CALL_WORDS.has(before.value) &&
      bodyRangeAfter(tokens, closeParen, bracePairs) !== null;
    if (!arrow && !method) continue;
    if (method) declarationFunctionIndexes.add(openParen - 1);
    const parameterIndexes = findParameterNames(tokens, openParen + 1, closeParen - 1);
    for (const parameterIndex of parameterIndexes) {
      scopeByIndex.set(parameterIndex, "variable.parameter");
    }
    const body = bodyRangeAfter(tokens, closeParen, bracePairs);
    if (body !== null) {
      parameterRegions.push({
        names: new Set(
          parameterIndexes.map((parameterIndex) => tokens[parameterIndex]?.value ?? ""),
        ),
        ...body,
      });
    }
  }

  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (!isWord(tokens[index]) || tokens[index + 1]?.value !== "=>") continue;
    scopeByIndex.set(index, "variable.parameter");
  }

  for (const region of parameterRegions) {
    for (let index = region.start; index < region.end; index += 1) {
      const token = tokens[index];
      if (!isWord(token) || !region.names.has(token.value)) continue;
      if (tokens[index - 1]?.value === "." || tokens[index - 1]?.value === "?.") continue;
      scopeByIndex.set(index, "variable.parameter.reference");
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isWord(token)) continue;
    const previous = tokens[index - 1]?.value;
    const callParen = callParenAfter(tokens, index);
    if (declarationFunctionIndexes.has(index)) {
      scopeByIndex.set(index, "entity.name.function.declaration");
      continue;
    }
    if (callParen !== null && !NON_CALL_WORDS.has(token.value) && previous !== "new") {
      scopeByIndex.set(index, "entity.name.function");
      continue;
    }
    const screamingConstant = token.value.includes("_") && /^[A-Z0-9_]+$/.test(token.value);
    if (
      TYPE_WORDS.has(token.value) ||
      (CAPITALIZED.test(token.value) && !screamingConstant) ||
      ["class", "enum", "interface", "type"].includes(previous ?? "")
    ) {
      scopeByIndex.set(index, "entity.name.type");
    }
  }

  return [...scopeByIndex]
    .sort(([left], [right]) => left - right)
    .slice(0, MAX_SEMANTIC_TOKENS)
    .map(([index, scope]) => {
      const token = tokens[index]!;
      return { line: token.line, start: token.start, length: token.length, scope };
    });
}

export function encodeSyntaxTokens(tokens: readonly SyntaxToken[]): Uint32Array {
  const data: number[] = [];
  let previousLine = 0;
  let previousStart = 0;
  for (const token of tokens) {
    const deltaLine = token.line - previousLine;
    const deltaStart = deltaLine === 0 ? token.start - previousStart : token.start;
    data.push(deltaLine, deltaStart, token.length, SEMANTIC_SCOPES.indexOf(token.scope), 0);
    previousLine = token.line;
    previousStart = token.start;
  }
  return new Uint32Array(data);
}

function createProvider(monaco: MonacoRuntime): MonacoSemanticTokensProvider {
  const cache = new WeakMap<MonacoModel, { version: number; data: Uint32Array }>();
  return {
    getLegend: () => ({ tokenTypes: SEMANTIC_SCOPES, tokenModifiers: [] }),
    provideDocumentSemanticTokens(model, _lastResultId, cancellation) {
      const version = model.getVersionId();
      const cached = cache.get(model);
      if (cached?.version === version) return { resultId: String(version), data: cached.data };
      if (cancellation.isCancellationRequested) {
        return { resultId: String(version), data: new Uint32Array() };
      }
      const source = model.getValue();
      let lexicalLines: LexicalToken[][] | undefined;
      try {
        lexicalLines = monaco.editor.tokenize(source, model.getLanguageId());
      } catch {
        lexicalLines = undefined;
      }
      const data = encodeSyntaxTokens(syntaxTokensForSource(source, lexicalLines));
      cache.set(model, { version, data });
      return { resultId: String(version), data };
    },
    releaseDocumentSemanticTokens() {},
  };
}

function attachRuntime(monaco: MonacoRuntime): () => void {
  const previousOptions = new Map<MonacoEditor, true | false | "configuredByTheme">();
  const enable = (editor: MonacoEditor) => {
    if (!previousOptions.has(editor)) {
      previousOptions.set(
        editor,
        editor.getRawOptions()["semanticHighlighting.enabled"] ?? "configuredByTheme",
      );
    }
    editor.updateOptions({ "semanticHighlighting.enabled": true });
  };
  const providers = ["javascript", "typescript"].map((languageId) =>
    monaco.languages.registerDocumentSemanticTokensProvider(languageId, createProvider(monaco)),
  );
  for (const editor of monaco.editor.getEditors()) enable(editor);
  const created = monaco.editor.onDidCreateEditor(enable);
  return () => {
    for (const provider of providers) provider.dispose();
    created.dispose();
    for (const [editor, setting] of previousOptions) {
      try {
        editor.updateOptions({ "semanticHighlighting.enabled": setting });
      } catch {
        // The editor may have been disposed before the theme changed.
      }
    }
  };
}

const FUNCTION_CLASS = "bb-monokai-syntax-function";
const FUNCTION_DECLARATION_CLASS = "bb-monokai-syntax-function-declaration";

function decorateMonacoLine(line: HTMLElement): void {
  const leaves = Array.from(line.querySelectorAll<HTMLElement>("span")).filter(
    (span) => span.childElementCount === 0,
  );
  for (const leaf of leaves) leaf.classList.remove(FUNCTION_CLASS, FUNCTION_DECLARATION_CLASS);

  const source = (line.textContent ?? "").replaceAll("\u00a0", " ");
  const functions = syntaxTokensForSource(source).filter(
    (token) =>
      token.line === 0 &&
      (token.scope === "entity.name.function" ||
        token.scope === "entity.name.function.declaration"),
  );
  if (functions.length === 0) return;

  let offset = 0;
  for (const leaf of leaves) {
    const length = leaf.textContent?.length ?? 0;
    const start = offset;
    const end = start + length;
    offset = end;
    for (const token of functions) {
      if (token.start < start || token.start + token.length > end) continue;
      const tokenText = source.slice(token.start, token.start + token.length);
      if (leaf.textContent?.trim() !== tokenText) continue;
      leaf.classList.add(FUNCTION_CLASS);
      if (token.scope === "entity.name.function.declaration") {
        leaf.classList.add(FUNCTION_DECLARATION_CLASS);
      }
    }
  }
}

function mountMonacoDomFallback(): () => void {
  let frame: number | null = null;
  let disposed = false;
  const decorate = () => {
    frame = null;
    if (disposed) return;
    for (const line of document.querySelectorAll<HTMLElement>(".monaco-editor .view-line")) {
      decorateMonacoLine(line);
    }
  };
  const schedule = () => {
    if (frame !== null || disposed) return;
    frame = requestAnimationFrame(decorate);
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.target instanceof Element
          ? record.target.closest(".monaco-editor") !== null
          : record.target.parentElement?.closest(".monaco-editor") !== null,
      )
    ) {
      schedule();
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  schedule();
  return () => {
    disposed = true;
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    for (const span of document.querySelectorAll<HTMLElement>(
      `.${FUNCTION_CLASS}, .${FUNCTION_DECLARATION_CLASS}`,
    )) {
      span.classList.remove(FUNCTION_CLASS, FUNCTION_DECLARATION_CLASS);
    }
  };
}

function browserDependencies(): MonacoSyntaxDependencies {
  return {
    findModuleUrls: () =>
      Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
        .map((link) => link.href)
        .filter((href) => EDITOR_STYLESHEET.test(href))
        .map((href) => href.replace(EDITOR_STYLESHEET, "/editor.js")),
    importModule: (url) => import(/* @vite-ignore */ url) as Promise<MonacoModule>,
    isThemeActive: () => isMonokaiThemeActive(getComputedStyle(document.documentElement)),
    mountFallback: mountMonacoDomFallback,
    observe: (listener) => {
      const observer = new MutationObserver(listener);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      observer.observe(document.head, {
        attributes: true,
        attributeFilter: ["href"],
        childList: true,
        characterData: true,
        subtree: true,
      });
      return () => observer.disconnect();
    },
  };
}

export function mountMonacoSyntaxTokens(
  { signal }: PluginContentScriptContext,
  dependencies: MonacoSyntaxDependencies = browserDependencies(),
): () => void {
  const registry = globalThis as MountRegistry;
  registry[ACTIVE_MOUNT]?.();
  const attached = new Map<string, () => void>();
  const pending = new Set<string>();
  let disposed = false;
  let refreshQueued = false;
  let fallbackDispose: (() => void) | null = null;
  let epoch = 0;

  const deactivate = () => {
    epoch += 1;
    for (const dispose of attached.values()) dispose();
    attached.clear();
    fallbackDispose?.();
    fallbackDispose = null;
  };

  const refresh = async () => {
    refreshQueued = false;
    if (disposed) return;
    if (!dependencies.isThemeActive()) {
      deactivate();
      return;
    }
    const activeEpoch = epoch;
    const moduleUrls = dependencies.findModuleUrls();
    if (attached.size === 0) fallbackDispose ??= dependencies.mountFallback();
    for (const url of moduleUrls) {
      if (attached.has(url) || pending.has(url)) continue;
      pending.add(url);
      try {
        const module = await dependencies.importModule(url);
        if (disposed || epoch !== activeEpoch || !dependencies.isThemeActive()) continue;
        if (module.monaco !== undefined) {
          attached.set(url, attachRuntime(module.monaco));
        }
      } catch {
        // A Monaco preview lease can disappear during plugin reload. A later DOM change retries it.
      } finally {
        pending.delete(url);
      }
    }
  };

  const scheduleRefresh = () => {
    if (refreshQueued || disposed) return;
    refreshQueued = true;
    queueMicrotask(() => void refresh());
  };
  const stopObserving = dependencies.observe(scheduleRefresh);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    stopObserving();
    deactivate();
    if (registry[ACTIVE_MOUNT] === dispose) delete registry[ACTIVE_MOUNT];
  };
  signal.addEventListener("abort", dispose, { once: true });
  registry[ACTIVE_MOUNT] = dispose;
  scheduleRefresh();
  return dispose;
}
