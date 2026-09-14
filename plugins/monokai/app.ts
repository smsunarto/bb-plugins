import { definePluginApp } from "@get-bb/plugin-sdk/app";

import "./app/monaco-syntax-tokens.css";
import "./app/diff-header.css";
import { mountDiffHeader } from "./app/diff-header.ts";

import { mountTerminalAppearance } from "./app/terminal-appearance.ts";
import { mountMonacoSyntaxTokens } from "./app/monaco-syntax-tokens.ts";
import { UiFontBridge } from "./app/ui-font-bridge.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "diff-header", mount: mountDiffHeader });
  app.contentScripts.register({
    id: "terminal-appearance",
    mount: mountTerminalAppearance,
  });
  app.slots.experimental_appOverlay({
    id: "ui-font",
    component: UiFontBridge,
  });
  app.contentScripts.register({
    id: "monaco-syntax-tokens",
    mount: mountMonacoSyntaxTokens,
  });
});
