import { definePluginApp } from "@get-bb/plugin-sdk/app";

import "./app/monaco-syntax-tokens.css";

import { mountTerminalAppearance } from "./app/terminal-appearance.ts";
import { mountFontPreference } from "./app/font-preference.ts";
import { mountMonacoSyntaxTokens } from "./app/monaco-syntax-tokens.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "terminal-appearance",
    mount: mountTerminalAppearance,
  });
  app.contentScripts.register({
    id: "ui-font",
    mount: mountFontPreference,
  });
  app.contentScripts.register({
    id: "monaco-syntax-tokens",
    mount: mountMonacoSyntaxTokens,
  });
});
