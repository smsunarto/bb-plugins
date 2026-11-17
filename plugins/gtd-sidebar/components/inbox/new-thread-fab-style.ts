/**
 * While the phone drawer shows gtd-sidebar's floating New thread pill, which
 * mounts only at bb's compact viewport, bb's New thread in the sidebar's top
 * row is redundant. bb's header slot takes no replacement for it, so:
 *
 * - One rule hides bb's New thread.
 * - A second collapses the top row when its header slot holds nothing else,
 *   so the list starts at the top of the drawer. The row's history arrows go
 *   with it; the phone has its own back gesture, and Monokai already hides
 *   them there.
 *
 * Wherever the pill is absent (desktop, another thread list, the plugin off)
 * bb's row stays as it was.
 */
import { NEW_THREAD_FAB_ATTRIBUTE } from "./new-thread-fab";

const STYLE_MARK = "data-gtd-new-thread-fab-style";
const WITH_PILL = `[data-testid="app-sidebar-body"]:has([${NEW_THREAD_FAB_ATTRIBUTE}])`;
const RULES = `${WITH_PILL} [data-sidebar-header-slot] button[aria-label^="New thread"] { display: none; }
${WITH_PILL} > [data-testid="app-sidebar-top-reserve-row"]:not(:has([data-sidebar-header-slot] button:not([aria-label^="New thread"]))) { display: none; }`;

export function mountNewThreadFabStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARK, "");
  style.textContent = RULES;
  document.head.append(style);
  return () => style.remove();
}
