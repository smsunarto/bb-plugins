import { describe, expect, test } from "bun:test";

import {
  encodeSyntaxTokens,
  isMonokaiThemeActive,
  type MonacoDomFallbackDependencies,
  type MonacoSyntaxDependencies,
  mountMonacoDomFallback,
  mountMonacoSyntaxTokens,
  syntaxTokensForSource,
} from "../app/monaco-syntax-tokens.ts";

function scopesFor(source: string): Map<string, string[]> {
  const lines = source.split("\n");
  const result = new Map<string, string[]>();
  for (const token of syntaxTokensForSource(source)) {
    const text = lines[token.line]?.slice(token.start, token.start + token.length) ?? "";
    result.set(text, [...(result.get(text) ?? []), token.scope]);
  }
  return result;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Standalone Monaco keeps editor options in one configuration service that every editor shares.
function fakeMonacoConfiguration() {
  return { semanticHighlighting: "configuredByTheme" as unknown };
}

function fakeMonacoEditor(configuration = fakeMonacoConfiguration()) {
  const editor = {
    applied: [] as unknown[],
    constructing: false,
    getRawOptions: () => ({}),
    // Monaco drops option writes made while the editor constructor is still running.
    updateOptions: (options: { "semanticHighlighting.enabled": unknown }) => {
      if (editor.constructing) return;
      editor.applied.push(options["semanticHighlighting.enabled"]);
      configuration.semanticHighlighting = options["semanticHighlighting.enabled"];
    },
  };
  return editor;
}

type FakeProvider = {
  provideDocumentSemanticTokens(
    model: object,
    lastResultId: null,
    cancellation: { isCancellationRequested: boolean },
  ): { resultId: string; data: Uint32Array };
};

function mountWithFakeMonaco(
  liveEditors: object[] = [],
  configuration = fakeMonacoConfiguration(),
) {
  const controller = new AbortController();
  const providers: FakeProvider[] = [];
  let createListener: ((editor: object) => void) | null = null;
  let tokenized = 0;
  mountMonacoSyntaxTokens({ signal: controller.signal } as never, {
    findModuleUrls: () => ["https://bb.test/editor.js"],
    importModule: async () =>
      ({
        monaco: {
          editor: {
            getEditors: () => liveEditors,
            onDidCreateEditor: (listener: (editor: object) => void) => {
              createListener = listener;
              return { dispose: () => (createListener = null) };
            },
            tokenize: () => {
              tokenized += 1;
              return [];
            },
          },
          languages: {
            registerDocumentSemanticTokensProvider: (
              _languageId: string,
              provider: FakeProvider,
            ) => {
              providers.push(provider);
              return { dispose() {} };
            },
          },
        },
      }) as never,
    isThemeActive: () => true,
    mountFallback: () => () => {},
    observe: () => () => {},
  });
  return {
    abort: () => controller.abort(),
    configuration,
    create: () => {
      const editor = fakeMonacoEditor(configuration);
      editor.constructing = true;
      createListener?.(editor);
      editor.constructing = false;
      liveEditors.push(editor);
      return editor;
    },
    close: (editor: object) => liveEditors.splice(liveEditors.indexOf(editor), 1),
    providers,
    tokenized: () => tokenized,
  };
}

function fakeMonacoLine(...texts: string[]) {
  const spans = texts.map((text) => {
    const classes = new Set<string>();
    return {
      childElementCount: 0,
      classes,
      classList: {
        add: (...names: string[]) => names.forEach((name) => classes.add(name)),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      },
      textContent: text,
    };
  });
  const line = { querySelectorAll: () => spans, textContent: texts.join("") };
  return { line: line as unknown as HTMLElement, spans };
}

describe("Monaco syntax-derived tokens", () => {
  test("recognizes an already-loaded Monokai stylesheet after a plugin reload", () => {
    const style = (properties: Record<string, string>) => ({
      getPropertyValue: (property: string) => properties[property] ?? "",
    });

    expect(isMonokaiThemeActive(style({ "--bb-monokai-active": "1" }))).toBe(true);
    expect(isMonokaiThemeActive(style({ "--canvas": "#151515", "--ink": "#e3e3dd" }))).toBe(false);
  });

  test("approximates Cursor roles without a TypeScript language service", () => {
    const source = `export type LauncherOptions = {
  launcherPath: string;
};

const REQUIRED_STATUS_KEYS = ["Repo"] as const;

export function parseLauncherStatus(output: string): LauncherTarget {
  const values = new Map<string, string>();
  for (const line of output.split("\\n")) {
    values.set(line.slice(0));
  }
  return required(values, "Repo");
}`;
    const scopes = scopesFor(source);

    expect(scopes.get("type")).toContain("storage.type");
    expect(scopes.get("const")).toEqual([
      "storage.type",
      "storage.type",
      "storage.type",
      "storage.type",
    ]);
    expect(scopes.get("function")).toEqual(["storage.type"]);
    expect(scopes.get("LauncherOptions")).toContain("entity.name.type");
    expect(scopes.get("LauncherTarget")).toContain("entity.name.type");
    expect(scopes.get("Map")).toContain("entity.name.type");
    expect(scopes.get("string")).toEqual([
      "entity.name.type",
      "entity.name.type",
      "entity.name.type",
      "entity.name.type",
    ]);
    expect(scopes.get("parseLauncherStatus")).toEqual(["entity.name.function.declaration"]);
    expect(scopes.get("output")).toEqual(["variable.parameter", "variable.parameter.reference"]);
    expect(scopes.get("split")).toEqual(["entity.name.function"]);
    expect(scopes.get("set")).toEqual(["entity.name.function"]);
    expect(scopes.get("slice")).toEqual(["entity.name.function"]);
    expect(scopes.get("required")).toEqual(["entity.name.function"]);
    expect(scopes.has("REQUIRED_STATUS_KEYS")).toBe(false);
    expect(scopes.has("values")).toBe(false);
    expect(scopes.has("line")).toBe(false);
  });

  test("ignores callable-looking text in comments, strings, templates, and regex", () => {
    const source = `// ignoredCall()
const text = "ignoredString()";
const template = \`ignoredTemplate()\`;
const matcher = /ignoredRegex[(][)]/;
actualCall();`;
    const scopes = scopesFor(source);

    expect(scopes.has("ignoredCall")).toBe(false);
    expect(scopes.has("ignoredString")).toBe(false);
    expect(scopes.has("ignoredTemplate")).toBe(false);
    expect(scopes.has("ignoredRegex")).toBe(false);
    expect(scopes.get("actualCall")).toEqual(["entity.name.function"]);
  });

  test("marks only the function name before a generic parameter list", () => {
    const scopes = scopesFor("function identity<T>(value: T): T { return value; }");

    expect(scopes.get("identity")).toEqual(["entity.name.function.declaration"]);
    expect(scopes.get("T")).toEqual(["entity.name.type", "entity.name.type", "entity.name.type"]);
  });

  test("keeps the DOM fallback active after Monaco attaches", async () => {
    const controller = new AbortController();
    let fallbackMounts = 0;
    let fallbackDisposals = 0;
    const dependencies: MonacoSyntaxDependencies = {
      findModuleUrls: () => ["https://bb.test/editor.js"],
      importModule: async () =>
        ({
          monaco: {
            editor: {
              getEditors: () => [],
              onDidCreateEditor: () => ({ dispose() {} }),
              tokenize: () => [],
            },
            languages: {
              registerDocumentSemanticTokensProvider: () => ({ dispose() {} }),
            },
          },
        }) as never,
      isThemeActive: () => true,
      mountFallback: () => {
        fallbackMounts += 1;
        return () => {
          fallbackDisposals += 1;
        };
      },
      observe: () => () => {},
    };

    mountMonacoSyntaxTokens({ signal: controller.signal } as never, dependencies);
    await Promise.resolve();
    await Promise.resolve();

    expect(fallbackMounts).toBe(1);
    expect(fallbackDisposals).toBe(0);

    controller.abort();
    expect(fallbackDisposals).toBe(1);
  });

  test("enables semantic tokens on editors Monaco creates after attaching", async () => {
    const monaco = mountWithFakeMonaco();
    await flush();

    const editor = monaco.create();
    await Promise.resolve();
    expect(editor.applied).toEqual([true]);

    monaco.abort();
    expect(editor.applied).toEqual([true, "configuredByTheme"]);
  });

  test("leaves a new editor's setting alone when the theme detaches first", async () => {
    const monaco = mountWithFakeMonaco();
    await flush();

    const editor = monaco.create();
    monaco.abort();
    await flush();

    expect(editor.applied).toEqual(["configuredByTheme"]);
  });

  test("restores the shared setting after every editor has closed", async () => {
    const configuration = fakeMonacoConfiguration();
    const existing = fakeMonacoEditor(configuration);
    const monaco = mountWithFakeMonaco([existing], configuration);
    await flush();
    const created = monaco.create();
    await flush();
    expect(configuration.semanticHighlighting).toBe(true);

    monaco.close(existing);
    monaco.close(created);
    monaco.abort();

    expect(configuration.semanticHighlighting).toBe("configuredByTheme");
  });

  test("restores the shared setting through an editor that is still open", async () => {
    const configuration = fakeMonacoConfiguration();
    const existing = fakeMonacoEditor(configuration);
    const monaco = mountWithFakeMonaco([existing], configuration);
    await flush();
    const created = monaco.create();
    await flush();

    monaco.close(existing);
    monaco.abort();

    expect(existing.applied).toEqual([true]);
    expect(created.applied).toEqual([true, "configuredByTheme"]);
    expect(configuration.semanticHighlighting).toBe("configuredByTheme");
  });

  test("skips Monaco tokenization for sources past the size cap", async () => {
    const monaco = mountWithFakeMonaco();
    await flush();
    const model = {
      getLanguageId: () => "typescript",
      getValue: () => "a();".repeat(250_001),
      getValueLength: () => 1_000_004,
      getVersionId: () => 7,
    };

    const result = monaco.providers[0]?.provideDocumentSemanticTokens(model, null, {
      isCancellationRequested: false,
    });

    expect(result).toEqual({ resultId: "7", data: new Uint32Array() });
    expect(monaco.tokenized()).toBe(0);
    monaco.abort();
  });

  test("decorates a re-rendered Monaco line before the next frame", () => {
    const callbacks: MutationCallback[] = [];
    let frameRequests = 0;
    const { line, spans } = fakeMonacoLine("run", "();");
    const replaced = {} as MutationRecord;
    const dispose = mountMonacoDomFallback({
      body: {} as Node,
      cancelFrame: () => {},
      createObserver: (callback) => {
        callbacks.push(callback);
        return { disconnect() {}, observe() {} };
      },
      findDecoratedSpans: () => [],
      findEditors: () => [{} as Element],
      findLines: () => [],
      findMutatedLines: (record) => (record === replaced ? [line] : []),
      mutationContainsEditor: () => false,
      requestFrame: () => {
        frameRequests += 1;
        return frameRequests;
      },
    });

    callbacks[1]?.([replaced], {} as MutationObserver);

    expect(spans.map((span) => Array.from(span.classes))).toEqual([
      ["bb-monokai-syntax-function"],
      [],
    ]);
    expect(frameRequests).toBe(1);
    dispose();
  });

  test("mounts character-data observation only after a Monaco editor root exists", () => {
    const body = {} as Node;
    const editor = {} as Element;
    const editorContainer = {} as Node;
    const observers: Array<{
      callback: MutationCallback;
      disconnects: number;
      observations: Array<{ target: Node; options: MutationObserverInit }>;
    }> = [];
    let editors: readonly Element[] = [];
    let frameRequests = 0;
    const dependencies: MonacoDomFallbackDependencies = {
      body,
      cancelFrame: () => {},
      createObserver: (callback) => {
        const state: (typeof observers)[number] = { callback, disconnects: 0, observations: [] };
        observers.push(state);
        return {
          disconnect: () => {
            state.disconnects += 1;
          },
          observe: (target, options) => state.observations.push({ target, options }),
        };
      },
      findDecoratedSpans: () => [],
      findEditors: () => editors,
      findLines: () => [],
      findMutatedLines: () => [],
      mutationContainsEditor: (node) => node === editorContainer,
      requestFrame: () => {
        frameRequests += 1;
        return frameRequests;
      },
    };

    const dispose = mountMonacoDomFallback(dependencies);

    expect(observers).toHaveLength(1);
    expect(observers[0]?.observations).toEqual([
      { target: body, options: { childList: true, subtree: true } },
    ]);
    expect(frameRequests).toBe(0);

    editors = [editor];
    observers[0]?.callback(
      [{ addedNodes: [editorContainer], removedNodes: [] } as unknown as MutationRecord],
      {} as MutationObserver,
    );

    expect(observers).toHaveLength(2);
    expect(observers[1]?.observations).toEqual([
      {
        target: editor,
        options: { childList: true, characterData: true, subtree: true },
      },
    ]);
    expect(frameRequests).toBe(1);

    dispose();
    expect(observers.map((observer) => observer.disconnects)).toEqual([1, 1]);
  });

  test("encodes sorted Monaco semantic token deltas", () => {
    expect([
      ...encodeSyntaxTokens([
        { line: 1, start: 2, length: 3, scope: "entity.name.function" },
        { line: 1, start: 9, length: 4, scope: "variable.parameter" },
        { line: 3, start: 1, length: 5, scope: "entity.name.type" },
      ]),
    ]).toEqual([1, 2, 3, 1, 0, 0, 7, 4, 3, 0, 2, 1, 5, 5, 0]);
  });
});
