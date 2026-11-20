import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * The phone right panel's depth: the parts of the theme's "Phone right panel
 * depth" rules that CSS cannot reach.
 *
 * bb slides the page (`[data-sidebar="inset"]`) left to show the panel. At rest
 * open, the page carries `data-panel-shelf="full"` and the theme places it one
 * panel width aside. While a finger drags it, or bb settles a swipe, bb drives
 * the page with an inline `translate` (negative toward the panel) and
 * `transition` (`none` while dragging). `data-panel-shelf` is absent on desktop
 * and while the left drawer is open.
 *
 * - **Cap:** bb sizes the swipe that opens the panel by the screen's width, so
 *   it would carry the page past the panel. A translate past the panel's width
 *   is written back to it.
 * - **Wash:** a `[data-monokai-panel-wash]` element, the last child of the page,
 *   carries the scrim and its hairline. Its opacity is how far the page has
 *   slid, 0 to 1, so the scrim fades with the gesture. A property set on the
 *   page could not drive it: a non-inherited one never reaches a pseudo-element,
 *   and an inherited one would restyle the whole thread every frame.
 * - **Framing:** `data-monokai-panel-depth` marks the page, and the document
 *   root, while the page is aside: "dragging" under a finger. It stays through
 *   the slide back, until bb's translate transition ends, so the corners stay
 *   round until the page lands. The root mark hides the left drawer, which bb
 *   keeps mounted behind the page's left edge.
 * - **Tap to close:** a tap on the wash closes the panel through bb's own
 *   Escape handling, as a tap on the left drawer's backdrop closes the drawer.
 * - **Swipe to close:** the wash sits inside bb's page, where a left-to-right
 *   swipe opens the left drawer. The wash opts out of that swipe with bb's
 *   `data-no-sidebar-swipe`, and a left-to-right swipe across it closes the
 *   panel the way a tap does.
 */
const INSET = '[data-sidebar="inset"]';
const PANEL_SHELF = "data-panel-shelf";
const DEPTH = "data-monokai-panel-depth";
const WASH = "data-monokai-panel-wash";
/** bb's opt-out from its left drawer's swipe, read from the touch's target. */
const NO_SIDEBAR_SWIPE = "data-no-sidebar-swipe";
/** bb's own horizontal swipe threshold for panel tabs. */
const SWIPE_MIN_PX = 30;
/** The theme's panel width: 90vw. */
const panelWidth = (view: Window) => view.innerWidth * 0.9;
/** bb's settle is 220ms; this covers a missed transitionend. */
const SETTLE_FALLBACK_MS = 260;

export function mountPanelDepth({
  signal,
  document: doc = document,
}: Pick<PluginContentScriptContext, "signal"> & { document?: Document }) {
  const view = doc.defaultView;
  if (signal.aborted || view === null) return () => {};
  const win: Window = view;
  const root = doc.documentElement;
  let inset: HTMLElement | null = null;
  let wash: HTMLElement | null = null;
  let settleTimer: number | undefined;
  let swipe: { id: number; x: number; y: number } | null = null;

  /** The page's wash element, added as its last child when missing. */
  function washOf(page: HTMLElement): HTMLElement {
    if (wash === null || wash.parentElement !== page) {
      wash?.remove();
      wash = doc.createElement("div");
      wash.setAttribute(WASH, "");
      wash.setAttribute("aria-hidden", "true");
      wash.setAttribute(NO_SIDEBAR_SWIPE, "");
      wash.style.opacity = "0";
    }
    if (page.lastElementChild !== wash) page.append(wash);
    return wash;
  }

  function setDepth(page: HTMLElement, depth: string | null) {
    win.clearTimeout(settleTimer);
    settleTimer = undefined;
    for (const element of [page, root]) {
      if (depth === null) element.removeAttribute(DEPTH);
      else if (element.getAttribute(DEPTH) !== depth) element.setAttribute(DEPTH, depth);
    }
  }

  function clear(page: HTMLElement) {
    setDepth(page, null);
    wash?.remove();
    wash = null;
  }

  function update(page: HTMLElement) {
    const shelf = page.getAttribute(PANEL_SHELF);
    if (shelf === null) {
      if (page.hasAttribute(DEPTH) || wash !== null) clear(page);
      return;
    }
    const width = panelWidth(win);
    const offset = Number.parseFloat(page.style.translate);
    if (shelf !== "full" && offset < -width) {
      page.style.translate = `${-width}px`;
      return;
    }
    const sliding = offset < 0;
    const open = shelf === "full";
    const amount = sliding ? Math.min(1, -offset / width) : open && Number.isNaN(offset) ? 1 : 0;
    if (amount === 0 && !page.hasAttribute(DEPTH)) return;

    const overlay = washOf(page);
    const opacity = String(Math.round(amount * 1000) / 1000);
    if (overlay.style.opacity !== opacity) overlay.style.opacity = opacity;

    if (amount > 0 || open) {
      setDepth(page, sliding && page.style.transition === "none" ? "dragging" : "");
    } else if (settleTimer === undefined) {
      // Sliding back: let the wash fade, and keep the framing until the page lands.
      setDepth(page, "");
      settleTimer = win.setTimeout(() => clear(page), SETTLE_FALLBACK_MS);
    }
  }

  const onTransitionEnd = (event: TransitionEvent) => {
    if (inset === null || event.target !== inset || event.propertyName !== "translate") return;
    if (settleTimer !== undefined && inset.getAttribute(PANEL_SHELF) !== "full") clear(inset);
  };

  const closePanel = () => {
    doc.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const openOnWash = (target: EventTarget | null) =>
    wash !== null && target === wash && inset?.getAttribute(PANEL_SHELF) === "full";

  const onClick = (event: MouseEvent) => {
    if (!openOnWash(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  };

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches.item(0) : null;
    swipe =
      touch !== null && openOnWash(event.target)
        ? { id: touch.identifier, x: touch.clientX, y: touch.clientY }
        : null;
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (swipe === null) return;
    const start = swipe;
    swipe = null;
    const touch = Array.from(event.changedTouches).find((t) => t.identifier === start.id);
    if (touch === undefined || inset?.getAttribute(PANEL_SHELF) !== "full") return;
    const dx = touch.clientX - start.x;
    if (dx >= SWIPE_MIN_PX && dx > Math.abs(touch.clientY - start.y)) closePanel();
  };

  const onTouchCancel = () => {
    swipe = null;
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const { target } = record;
      if (target instanceof HTMLElement && target.matches(INSET)) {
        if (inset !== null && inset !== target) clear(inset);
        inset = target;
        update(target);
        return;
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: [PANEL_SHELF, "style"],
  });
  doc.addEventListener("transitionend", onTransitionEnd, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  doc.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  doc.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });

  // One initial query; later work reads only mutation targets.
  const initial = doc.querySelector(INSET);
  if (initial instanceof HTMLElement) {
    inset = initial;
    update(initial);
  }

  const dispose = () => {
    observer.disconnect();
    doc.removeEventListener("transitionend", onTransitionEnd, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("touchstart", onTouchStart, true);
    doc.removeEventListener("touchend", onTouchEnd, true);
    doc.removeEventListener("touchcancel", onTouchCancel, true);
    if (inset !== null) clear(inset);
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
