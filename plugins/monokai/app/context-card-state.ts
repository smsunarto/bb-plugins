import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * Mirrors whether a thread's floating context card is open onto its
 * `[data-thread-window]` as `data-monokai-context-card`:
 *
 * - `shown` / `hidden`: the card is mounted, and its `hidden` attribute says which.
 * - `was-shown`: the chat is too narrow for the card (bb's banner layout, card
 *   unmounted) and the card was last seen shown.
 * - absent: no card state is known, or the pane has no context card at all.
 *
 * bb picks the card's layout from the chat width in a ResizeObserver and
 * applies the 312px chat shift a React render later, so a width snap shows
 * one frame with the wrong shift. The theme's container queries take the
 * width bands from CSS on the same frame; this attribute is the one input CSS
 * cannot read, because the card and the shifted column sit in sibling trees.
 * `was-shown` covers the frame a widening chat leaves the banner before bb
 * remounts the card. In the shift band bb always mounts the card, so the
 * remembered value can only stand for that one frame.
 */
const OVERLAY = "[data-scroll-overlay]";
const CARD = ":scope > [data-thread-context-card]";
// ThreadContextCard renders this probe in every layout, and nothing without a card.
const PROBE = ':scope > span[aria-hidden="true"]';
const WINDOW = "[data-thread-window]";
const ATTRIBUTE = "data-monokai-context-card";

export function contextCardState(
  window: Element,
  lastShown: boolean | undefined,
): "shown" | "hidden" | "was-shown" | null {
  const overlay = window.querySelector(OVERLAY);
  const card = overlay?.querySelector(CARD);
  if (card) return card.hasAttribute("hidden") ? "hidden" : "shown";
  return lastShown && overlay?.querySelector(PROBE) ? "was-shown" : null;
}

function holds(node: Node, selector: string): node is Element {
  if (!(node instanceof Element)) return false;
  return (
    node.matches(selector) ||
    (node.firstElementChild !== null && node.querySelector(selector) !== null)
  );
}

/** The thread windows whose card a mutation record may have changed. */
function touchedWindows(record: MutationRecord): Element[] {
  const target = record.target as Element;
  // The card's `hidden` flips, or the card or probe mounts in its overlay.
  const own =
    record.type === "attributes"
      ? target.matches("[data-thread-context-card]") && target.parentElement?.matches(OVERLAY)
      : target.matches(OVERLAY);
  if (own) {
    const window = target.closest(WINDOW);
    return window ? [window] : [];
  }
  if (record.type === "attributes") return [];
  // A whole pane mounts.
  const windows: Element[] = [];
  for (const node of record.addedNodes) {
    if (!holds(node, OVERLAY)) continue;
    for (const overlay of node.matches(OVERLAY) ? [node] : node.querySelectorAll(OVERLAY)) {
      const window = overlay.closest(WINDOW);
      if (window) windows.push(window);
    }
  }
  return windows;
}

export function mountContextCardState({ signal }: PluginContentScriptContext) {
  const lastShown = new WeakMap<Element, boolean>();
  const marked = new Set<Element>();
  const sync = (window: Element) => {
    const value = contextCardState(window, lastShown.get(window));
    if (value === "shown" || value === "hidden") lastShown.set(window, value === "shown");
    if (value === null) {
      window.removeAttribute(ATTRIBUTE);
      marked.delete(window);
      return;
    }
    if (window.getAttribute(ATTRIBUTE) !== value) window.setAttribute(ATTRIBUTE, value);
    marked.add(window);
  };

  const observer = new MutationObserver((records) => {
    const windows = new Set(records.flatMap(touchedWindows));
    for (const window of marked) if (!window.isConnected) marked.delete(window);
    for (const window of windows) sync(window);
  });

  for (const window of document.querySelectorAll(WINDOW)) sync(window);
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
