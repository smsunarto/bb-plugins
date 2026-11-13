import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * Mirrors whether a thread's floating context card is open onto its
 * `[data-thread-window]` as `data-monokai-context-card="shown" | "hidden"`.
 *
 * bb picks the card's layout from the chat width in a ResizeObserver and
 * applies the 312px chat shift a React render later, so a width snap shows
 * one frame with the wrong shift. The theme's container queries take the
 * width bands from CSS on the same frame; this attribute is the one input CSS
 * cannot read, because the card and the shifted column sit in sibling trees.
 * The attribute is removed when the card unmounts (bb's banner layout), so a
 * stale "shown" can never force the shift onto a thread without a card.
 */
const CARD = "[data-scroll-overlay] [data-thread-context-card]";
const CARD_ANYWHERE = "[data-thread-context-card]";
const WINDOW = "[data-thread-window]";
const ATTRIBUTE = "data-monokai-context-card";

export function syncContextCard(window: Element): void {
  const card = window.querySelector(CARD);
  const value = card === null ? null : card.hasAttribute("hidden") ? "hidden" : "shown";
  if (value === null) window.removeAttribute(ATTRIBUTE);
  else if (window.getAttribute(ATTRIBUTE) !== value) window.setAttribute(ATTRIBUTE, value);
}

function holdsCard(node: Node, selector: string): node is Element {
  if (!(node instanceof Element)) return false;
  return (
    node.matches(selector) ||
    (node.firstElementChild !== null && node.querySelector(selector) !== null)
  );
}

/** The thread windows whose card a mutation record may have changed. */
function touchedWindows(record: MutationRecord): Element[] {
  const target = record.target as Element;
  if (record.type === "attributes") {
    const window = target.matches(CARD) ? target.closest(WINDOW) : null;
    return window ? [window] : [];
  }
  const windows: Element[] = [];
  for (const node of record.addedNodes) {
    if (!holdsCard(node, CARD)) continue;
    const cards = node.matches(CARD) ? [node] : node.querySelectorAll(CARD);
    for (const card of cards) {
      const window = card.closest(WINDOW);
      if (window) windows.push(window);
    }
  }
  // A removed card is detached from its overlay, so match it bare and
  // re-read the window it left through the record's connected parent.
  if ([...record.removedNodes].some((node) => holdsCard(node, CARD_ANYWHERE))) {
    const window = target.closest?.(WINDOW);
    if (window) windows.push(window);
  }
  return windows;
}

export function mountContextCardState({ signal }: PluginContentScriptContext) {
  const marked = new Set<Element>();
  const sync = (window: Element) => {
    syncContextCard(window);
    if (window.hasAttribute(ATTRIBUTE)) marked.add(window);
    else marked.delete(window);
  };

  const observer = new MutationObserver((records) => {
    const windows = new Set(records.flatMap(touchedWindows));
    for (const window of marked) if (!window.isConnected) marked.delete(window);
    for (const window of windows) sync(window);
  });

  for (const card of document.querySelectorAll(CARD)) {
    const window = card.closest(WINDOW);
    if (window) sync(window);
  }
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });

  const dispose = () => {
    observer.disconnect();
    for (const window of marked) window.removeAttribute(ATTRIBUTE);
    marked.clear();
    signal.removeEventListener("abort", dispose);
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  return dispose;
}
