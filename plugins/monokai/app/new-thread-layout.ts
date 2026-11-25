import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const HOME = '[data-testid="root-compose-compact-home"]';
const VIEWPORT = "data-monokai-compose-viewport";
const DESKTOP = "(width > 767px)";

/** Mark BB's otherwise unlabelled desktop wrapper in both standalone and hosted panes. */
function observeDesktopHome(doc: Document, view: Window & typeof globalThis) {
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

  return () => {
    observer.disconnect();
    for (const wrapper of wrappers.keys()) wrapper.removeAttribute(VIEWPORT);
  };
}

export function mountNewThreadLayout({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  const view = doc.defaultView;
  if (!view || signal.aborted) return () => {};

  const media = view.matchMedia(DESKTOP);
  let stop: (() => void) | undefined;
  const syncViewport = () => {
    stop?.();
    stop = media.matches ? observeDesktopHome(doc, view) : undefined;
  };
  syncViewport();
  media.addEventListener("change", syncViewport);
  function dispose() {
    media.removeEventListener("change", syncViewport);
    signal.removeEventListener("abort", dispose);
    stop?.();
    stop = undefined;
  }
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
