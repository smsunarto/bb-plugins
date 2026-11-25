import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountNewThreadLayout } from "./app/new-thread-layout.ts";

import "./app/monaco-syntax-tokens.css";
import "./app/diff-header.css";
import "./app/project-control.css";
import { mountArchiveToast } from "./app/archive-toast.ts";
import { mountHairlineDensity } from "./app/hairline-density.ts";
import { mountBbDomStyles } from "./app/bb-dom-styles.ts";
import { mountPanelNewTab } from "./app/panel-new-tab.ts";
import { mountProjectControl } from "./app/project-control.ts";
import "./app/home-marker.css";
import { mountDiffHeader } from "./app/diff-header.ts";
import { mountPanelDepth } from "./app/panel-depth.ts";
import { mountPanelTabHaptics } from "./app/panel-tab-haptics.ts";
import { mountPanelTabGlide } from "./app/panel-tab-glide.ts";

import { mountTerminalAppearance } from "./app/terminal-appearance.ts";
import { mountThreadHeaderRows } from "./app/thread-header-rows.ts";
import { mountMonacoSyntaxTokens } from "./app/monaco-syntax-tokens.ts";
import { UiFontBridge } from "./app/ui-font-bridge.ts";
import { HomeMarker } from "./app/home-marker.ts";
import { ThreadMarker } from "./app/thread-marker.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "archive-toast", mount: mountArchiveToast });
  app.contentScripts.register({ id: "hairline-density", mount: mountHairlineDensity });
  app.contentScripts.register({ id: "bb-dom-styles", mount: mountBbDomStyles });
  app.contentScripts.register({ id: "thread-header-rows", mount: mountThreadHeaderRows });
  // Marks presses of the right panel's toggle and presses bb's new-tab button
  // when the thread marker's hook asks.
  app.contentScripts.register({ id: "panel-new-tab", mount: mountPanelNewTab });
  app.contentScripts.register({ id: "diff-header", mount: mountDiffHeader });
  app.contentScripts.register({ id: "project-control", mount: mountProjectControl });
  // The phone right panel mirrors the left drawer's depth; see app/panel-depth.ts.
  app.contentScripts.register({ id: "panel-depth", mount: mountPanelDepth });
  // A haptic tick as the right panel's active tab changes in bb's iOS app.
  app.contentScripts.register({ id: "panel-tab-haptics", mount: mountPanelTabHaptics });
  // The tab pager's highlight slides between same-size tabs; see app/panel-tab-glide.ts.
  app.contentScripts.register({ id: "panel-tab-glide", mount: mountPanelTabGlide });
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
  app.slots.experimental_threadHeaderRow({
    id: "thread-marker",
    component: ThreadMarker,
  });
  app.contentScripts.register({
    id: "monaco-syntax-tokens",
    mount: mountMonacoSyntaxTokens,
  });
  app.contentScripts.register({ id: "new-thread-layout", mount: mountNewThreadLayout });
});
