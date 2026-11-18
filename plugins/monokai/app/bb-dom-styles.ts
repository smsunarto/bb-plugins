import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

import { NEW_TAB_LAUNCHER_CSS } from "./new-tab-launcher.ts";
import { SEARCH_FIELDS_CSS } from "./search-fields.ts";
import { THREAD_MARKER_CSS } from "./thread-marker.ts";

/** Marks the one `<style>` this script appends, so a pass can find it. */
const STYLE_ATTRIBUTE = "data-monokai-bb-dom-styles";

/**
 * Content script: restyles bb's own DOM under every palette with one marked
 * `<style>`, removed on disposal. The plugin's app.css stays for its own roots
 * (repo AGENTS.md, DOM hacks). Each rule set's module documents the private bb
 * DOM it selects.
 */
export function mountBbDomStyles({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  if (signal.aborted) return () => {};
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = [SEARCH_FIELDS_CSS, NEW_TAB_LAUNCHER_CSS, THREAD_MARKER_CSS].join("");
  doc.head.append(style);
  return () => style.remove();
}
