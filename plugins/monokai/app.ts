import { definePluginApp } from "@get-bb/plugin-sdk/app";

import "./app/monaco-syntax-tokens.css";

import { mountFontPreference } from "./app/font-preference.ts";
import { mountMonacoSyntaxTokens } from "./app/monaco-syntax-tokens.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "ui-font",
    mount: mountFontPreference,
  });
  app.contentScripts.register({
    id: "monaco-syntax-tokens",
    mount: mountMonacoSyntaxTokens,
  });
});
