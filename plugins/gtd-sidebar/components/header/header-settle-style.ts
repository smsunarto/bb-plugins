/**
 * Hides bb's "…" thread menu in a header that shows the Settle button, which
 * renders only at compact width on a live thread. bb's slot takes no
 * replacement for the menu trigger, so one rule hides it; anywhere the button
 * is absent (desktop, a settled thread, a crashed slot, the plugin off) the
 * menu stays.
 */
import { HEADER_SETTLE_ATTRIBUTE } from "./header-settle";

const STYLE_MARK = "data-gtd-header-settle-style";
const RULE = `[data-testid="app-page-header-content-row"]:has([${HEADER_SETTLE_ATTRIBUTE}]) button[aria-label="Thread actions"] { display: none; }`;

export function mountHeaderSettleStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARK, "");
  style.textContent = RULE;
  document.head.append(style);
  return () => style.remove();
}
