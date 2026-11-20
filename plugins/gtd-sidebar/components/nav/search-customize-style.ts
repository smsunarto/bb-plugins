/**
 * Hides Search's checkbox in bb's Customize navigation editor. The Capy list
 * draws Search whatever its visibility says, so the checkbox would do nothing.
 * bb's editor takes no list of items to leave out, so one rule hides the
 * checkbox's label; the row keeps its place and drag handle for reordering.
 * The rule depends on bb's `data-plugin-nav-customize-checkbox` attribute.
 */
const STYLE_MARK = "data-gtd-search-customize-style";
const RULE = `label:has(> [data-plugin-nav-customize-checkbox="__bb__/search-threads"]) { visibility: hidden; }`;

export function mountSearchCustomizeStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARK, "");
  style.textContent = RULE;
  document.head.append(style);
  return () => style.remove();
}
