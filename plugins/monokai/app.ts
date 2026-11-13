import { definePluginApp } from "@get-bb/plugin-sdk/app";

import "./app/monaco-syntax-tokens.css";
import "./app/diff-header.css";
import "./app/project-control.css";
import { mountProjectControl } from "./app/project-control.ts";
// workaround:monokai/secondary-swipe-width-property begin
import "./app/secondary-panel-resize.css";
// workaround:monokai/secondary-swipe-width-property end
import "./app/home-marker.css";
import { mountDiffHeader } from "./app/diff-header.ts";
// workaround:monokai/context-card-late-layout begin
import { mountContextCardState } from "./app/context-card-state.ts";
// workaround:monokai/context-card-late-layout end

import { mountTerminalAppearance } from "./app/terminal-appearance.ts";
import { mountMonacoSyntaxTokens } from "./app/monaco-syntax-tokens.ts";
import { UiFontBridge } from "./app/ui-font-bridge.ts";
import { HomeMarker } from "./app/home-marker.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "diff-header", mount: mountDiffHeader });
  app.contentScripts.register({ id: "project-control", mount: mountProjectControl });
  // workaround:monokai/context-card-late-layout begin
  app.contentScripts.register({ id: "context-card-state", mount: mountContextCardState });
  // workaround:monokai/context-card-late-layout end
  app.contentScripts.register({
    id: "terminal-appearance",
    mount: mountTerminalAppearance,
  });
  app.slots.experimental_appOverlay({
    id: "ui-font",
    component: UiFontBridge,
  });
  app.slots.homepageSection({
    id: "home-marker",
    title: "New thread screen marker",
    component: HomeMarker,
  });
  app.contentScripts.register({
    id: "monaco-syntax-tokens",
    mount: mountMonacoSyntaxTokens,
  });
});
