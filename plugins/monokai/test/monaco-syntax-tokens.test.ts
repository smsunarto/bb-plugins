import { describe, expect, test } from "bun:test";

import {
  encodeSyntaxTokens,
  isMonokaiThemeActive,
  type MonacoSyntaxDependencies,
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

describe("Monaco syntax-derived tokens", () => {
  test("recognizes an already-loaded Monokai stylesheet after a plugin reload", () => {
    const style = (properties: Record<string, string>) => ({
      getPropertyValue: (property: string) => properties[property] ?? "",
    });

    expect(isMonokaiThemeActive(style({ "--bb-monokai-active": "1" }))).toBe(true);
    expect(isMonokaiThemeActive(style({ "--canvas": "#181818", "--ink": "#E3E3DD" }))).toBe(true);
    expect(isMonokaiThemeActive(style({ "--canvas": "#181818", "--ink": "#ffffff" }))).toBe(false);
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
