import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { HOME_ATTRIBUTE } from "./home-marker.ts";

const HOME = '[data-testid="root-compose-compact-home"]';
const COMPOSER = '[data-testid="root-compose-compact-composer"]';
const SCROLL_VIEWPORT = '[data-testid="root-compose-compact-scroll-viewport"]';
const VIEWPORT = "data-monokai-compose-viewport";
const DESKTOP = "(width > 767px)";
const THEME_STYLE_ID = "bb-app-theme";
const T3_HOST = "data-t3-composer-host";

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

function moveSibling(parent: Element, node: Element, before: ChildNode | null) {
  if (typeof parent.moveBefore === "function") parent.moveBefore(node, before);
  else parent.insertBefore(node, before);
}

function moveSiblingTemporarily(parent: Element, node: Element, before: ChildNode | null) {
  const originalNext = node.nextSibling;
  moveSibling(parent, node, before);
  return () => {
    if (!parent.isConnected || node.parentElement !== parent) return;
    if (originalNext?.parentNode === parent) moveSibling(parent, node, originalNext);
    else if (originalNext === null) moveSibling(parent, node, null);
  };
}

function orderRecents(composer: Element) {
  const home = composer.parentElement;
  const viewport = composer.previousElementSibling;
  if (home && viewport?.matches(SCROLL_VIEWPORT)) {
    return moveSiblingTemporarily(home, viewport, composer.nextSibling);
  }
}

function orderSelectorTray(shell: Element) {
  const footer = shell.querySelector(":scope > [data-new-thread-footer]");
  const box = footer?.previousElementSibling;
  if (footer && box?.matches("[data-composer-box]")) {
    return moveSiblingTemporarily(shell, footer, box);
  }
}

/** Match tab order to the compact layout without changing any node's parent. */
function observeCompactHome(doc: Document, view: Window & typeof globalThis) {
  const root = doc.documentElement;
  let home: Element | null = null;
  let shell: Element | null = null;
  let theme: Element | null = null;
  let restoreRecents: (() => void) | undefined;
  let restoreFooter: (() => void) | undefined;
  const observer = new view.MutationObserver(syncHome);

  function watchRoot() {
    observer.observe(root, { attributes: true, attributeFilter: [HOME_ATTRIBUTE] });
    observer.observe(doc.head, { childList: true });
    if (theme) observer.observe(theme, { childList: true, characterData: true, subtree: true });
  }

  function syncHome() {
    const activeTheme = doc.getElementById(THEME_STYLE_ID);
    const activeHome =
      root.hasAttribute(HOME_ATTRIBUTE) &&
      activeTheme?.textContent?.includes("--bb-monokai-active:")
        ? (doc.getElementById("root-compose-main-panel")?.querySelector(HOME) ?? null)
        : null;
    const composer = activeHome?.querySelector(`:scope > ${COMPOSER}`);
    const activeShell = composer?.querySelector("[data-app-composer]") ?? null;
    if (activeHome !== home || activeShell !== shell || activeTheme !== theme) {
      observer.disconnect();
      theme = activeTheme;
      watchRoot();
      if (activeHome) observer.observe(activeHome, { childList: true });
      if (activeShell) {
        observer.observe(activeShell, {
          childList: true,
          attributes: true,
          attributeFilter: [T3_HOST],
        });
      }
    }
    if (activeHome !== home) {
      restoreRecents?.();
      restoreRecents = undefined;
      home = activeHome;
    }
    const t3Active = activeShell?.hasAttribute(T3_HOST);
    if (activeShell !== shell || !t3Active) {
      restoreFooter?.();
      restoreFooter = undefined;
    }
    shell = activeShell;

    // BB places the viewport before its composer, though Monokai draws it below.
    if (composer) restoreRecents = orderRecents(composer) ?? restoreRecents;

    // T3 draws its selector tray above the editor with flex order.
    if (shell && t3Active) restoreFooter = orderSelectorTray(shell) ?? restoreFooter;
  }

  watchRoot();
  syncHome();
  return () => {
    observer.disconnect();
    restoreFooter?.();
    restoreRecents?.();
  };
}

export function mountNewThreadLayout({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  const view = doc.defaultView;
  if (!view || signal.aborted) return () => {};

  const media = view.matchMedia(DESKTOP);
  let stop = () => {};
  const syncViewport = () => {
    stop();
    stop = media.matches ? observeDesktopHome(doc, view) : observeCompactHome(doc, view);
  };
  syncViewport();
  media.addEventListener("change", syncViewport);
  function dispose() {
    media.removeEventListener("change", syncViewport);
    signal.removeEventListener("abort", dispose);
    stop();
    stop = () => {};
  }
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
