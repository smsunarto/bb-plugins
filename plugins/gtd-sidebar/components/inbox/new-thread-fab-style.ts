import { NEW_THREAD_FAB_ATTRIBUTE } from "./new-thread-fab";

const STYLE_MARK = "data-gtd-new-thread-fab-style";
// The SDK has no per-item visibility override. Match bb's built-in nav item
// by its ID, and only in the sidebar body that has the compact New pill.
const RULE = `[data-testid="app-sidebar-body"]:has([${NEW_THREAD_FAB_ATTRIBUTE}]) [data-sidebar-navigation-item="__bb__/new-thread"] { display: none; }`;

export function mountNewThreadFabStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARK, "");
  style.textContent = RULE;
  document.head.append(style);
  return () => style.remove();
}
