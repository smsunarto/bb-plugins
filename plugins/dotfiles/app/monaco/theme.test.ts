import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import { applyCodeTheme, monacoThemeName, toMonacoTheme } from "./theme.ts";

const theme: PluginCodeThemeData = {
  name: "Dotfiles Dark/Blue",
  type: "dark",
  fg: "#aabbcc",
  bg: "#112233",
  colors: {
    "editor.background": "#010203",
    invalid: "rgb(1, 2, 3)",
  },
  tokenColors: [
    { scope: "keyword, storage", settings: { foreground: "#abc", fontStyle: "bold nope" } },
    { scope: ["string"], settings: { background: "#12345678" } },
    { scope: "", settings: { foreground: "invalid" } },
  ],
};

test("translates BB code themes into Monaco theme data", () => {
  assert.deepEqual(toMonacoTheme(theme), {
    base: "vs-dark",
    inherit: false,
    rules: [
      { token: "", foreground: "aabbcc" },
      { token: "keyword", foreground: "aabbcc", fontStyle: "bold" },
      { token: "storage", foreground: "aabbcc", fontStyle: "bold" },
      { token: "string", background: "12345678" },
    ],
    colors: {
      "editor.background": "#010203",
      "editor.foreground": "#aabbcc",
    },
  });
  assert.equal(monacoThemeName(theme.name), "bb-Dotfiles-Dark-Blue");
});

test("defines resolved themes and falls back to the current BB mode", () => {
  const defineTheme = mock<(name: string, data: MonacoNs.editor.IStandaloneThemeData) => void>();
  const monaco = { editor: { defineTheme } } as unknown as typeof MonacoNs;

  assert.deepEqual(applyCodeTheme(monaco, { mode: "light", name: theme.name, theme }), {
    name: "bb-Dotfiles-Dark-Blue",
    base: "vs-dark",
  });
  assert.equal(defineTheme.mock.calls.length, 1);
  assert.deepEqual(applyCodeTheme(monaco, { mode: "dark", name: "loading", theme: null }), {
    name: "vs-dark",
    base: "vs-dark",
  });
  assert.equal(defineTheme.mock.calls.length, 1);
});
