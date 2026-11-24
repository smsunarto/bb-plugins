import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const HOME = '[data-testid="root-compose-compact-home"]';
const VIEWPORT = "data-monokai-compose-viewport";

/** Mark BB's otherwise unlabelled wrapper in both standalone and hosted panes. */
export function mountNewThreadLayout({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  const view = doc.defaultView;
  if (!view || signal.aborted) return () => {};

  const wrappers = new Map<Element, Element>();
  function mark(home: Element) {
    const wrapper = home.parentElement;
    if (!home.isConnected || !wrapper || wrappers.get(wrapper) === home) return;
    wrapper.setAttribute(VIEWPORT, "");
    wrappers.set(wrapper, home);
  }

  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof view.Element)) continue;
        if (node.matches(HOME)) mark(node);
        if (node.firstElementChild) node.querySelectorAll(HOME).forEach(mark);
      }
    }
    for (const [wrapper, home] of wrappers) {
      if (home.isConnected && home.parentElement === wrapper) continue;
      wrapper.removeAttribute(VIEWPORT);
      wrappers.delete(wrapper);
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.querySelectorAll(HOME).forEach(mark);

  function dispose() {
    observer.disconnect();
    signal.removeEventListener("abort", dispose);
    for (const wrapper of wrappers.keys()) wrapper.removeAttribute(VIEWPORT);
    wrappers.clear();
  }
  signal.addEventListener("abort", dispose);
  return dispose;
}
