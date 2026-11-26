/**
 * The side effects of opening either phone shelf, which bb's layout has no
 * event for: the left drawer (thread list) and the right panel (the thread's
 * secondary panel, which covers the screen on a phone).
 *
 * - As a shelf starts to open, it dismisses the keyboard by blurring a focused
 *   text field on the page. The iOS keyboard is a system window that cannot
 *   slide aside with the page, so it would otherwise cover the shelf. bb moves
 *   focus into the right panel once it is open, but a swipe keeps the keyboard
 *   up for the whole drag and settle until then.
 * - Once a shelf commits to opening, it plays a selection tick, iOS's lightest
 *   haptic. A tapped open commits as its slide starts; a swipe commits on
 *   release, when bb starts settling it open. Waiting for the end of bb's 220ms
 *   settle made the tick land after the shelf had visibly arrived.
 *
 * Both shelves slide the page (`[data-sidebar="inset"]`) aside. bb settles a
 * swipe with an inline `translate` transition toward the shelf's width (left
 * drawer, positive; right panel, negative) or `0px` (back), and moves the page
 * with `transition: none` while a finger drags it. The open state lives on:
 *
 * - Left drawer: the page's `data-sidebar-shelf`, "open" or "closed" at compact
 *   width and absent on desktop, and `data-vaul-animate`, present while bb
 *   drives the slide with inline styles. A tapped open slides with the shelf
 *   still "closed", then flips it to "open" and drops `data-vaul-animate` in one
 *   task. A swipe flips the shelf at drag start and keeps `data-vaul-animate`
 *   until the settle ends.
 * - Right panel: the panel's `data-state`, "full" or "closed", on
 *   `[data-testid="secondary-panel-shelf"]`, which bb mounts only at compact
 *   width and mounts closed. A tapped open flips it to "full". A swipe drags the page with the
 *   panel still "closed", and when the settle ends flips it to "full" and
 *   clears the page's inline styles in one task. The page's own
 *   `data-panel-shelf` follows the panel through a store and an effect, so it
 *   can land a task after the styles clear; it is not read.
 *
 * Each check reads the live elements after a mutation batch, so a cancelled
 * swipe, which closes the shelf in the same task that clears the slide, never
 * counts as open. Both effects run once per closed → open cycle of each shelf:
 * dragging an open shelf and letting it spring back does neither.
 *
 * The observers run only at bb's compact width, where both shelves exist. They
 * watch the page's inline `style` and `data-vaul-animate` directly on the page
 * itself (`subtree: false`), never document-wide. Document-wide, only the rare
 * `data-sidebar-shelf` and `data-state` attributes are watched so a page or
 * right panel mounted after the script is picked up immediately. Each batch
 * reads a few attributes and inline properties and no layout.
 */
import { nativeHaptic } from "./native-haptics";

const INSET = '[data-sidebar="inset"]';
const PANEL_TESTID = "secondary-panel-shelf";
const PANEL = `[data-testid="${PANEL_TESTID}"]`;
const SHELF = "data-sidebar-shelf";
const ANIMATING = "data-vaul-animate";
const PANEL_STATE = "data-state";
const TEXT_FIELD = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

/** Where a shelf is: absent, at rest closed, on its way open, or committed to being open. */
type ShelfReading = "none" | "closed" | "opening" | "committed";

interface Page {
  inset: Element | null;
  panel: Element | null;
}

/** bb is animating the page's slide toward a shelf, rather than dragging or resting it. */
function settling(inset: HTMLElement): boolean {
  const { transition } = inset.style;
  return transition !== "" && transition !== "none";
}

function slideOffset(inset: Element | null): number {
  return inset instanceof HTMLElement ? Number.parseFloat(inset.style.translate) : Number.NaN;
}

function readLeftDrawer({ inset }: Page): ShelfReading {
  const shelf = inset?.getAttribute(SHELF) ?? null;
  if (inset === null || shelf === null) return "none";
  if (!inset.hasAttribute(ANIMATING)) return shelf === "open" ? "committed" : "closed";
  return inset instanceof HTMLElement && settling(inset) && slideOffset(inset) > 0
    ? "committed"
    : "opening";
}

function readRightPanel({ inset, panel }: Page): ShelfReading {
  if (panel?.isConnected === true && panel.getAttribute(PANEL_STATE) === "full") return "committed";
  if (!(slideOffset(inset) < 0)) return "closed";
  return inset instanceof HTMLElement && settling(inset) ? "committed" : "opening";
}

const SHELVES = { left: readLeftDrawer, right: readRightPanel };
type Shelf = keyof typeof SHELVES;
/** Where a shelf is in its closed → open cycle; reset only by closing. */
type Cycle = "closed" | "opening" | "opened";

function dismissKeyboard(document: Document, inset: Element | null) {
  const focused = document.activeElement;
  if (
    inset !== null &&
    focused instanceof HTMLElement &&
    inset.contains(focused) &&
    focused.matches(TEXT_FIELD)
  ) {
    focused.blur();
  }
}

export interface PhoneDrawerEffects {
  /** A shelf has started to open; `inset` is the page it slides aside. */
  opening: (inset: Element | null) => void;
  /** A shelf has committed to opening: settling open, or open without a settle. */
  opened: () => void;
}

/** bb's compact breakpoint (`COMPACT_VIEWPORT_QUERY` in bb's shared UI). */
export const COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";

type CompactQuery = Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;

export interface PhoneDrawerOptions {
  /**
   * Gates the observers on bb's compact layout, the only one with shelves.
   * Defaults to the window's `matchMedia(COMPACT_VIEWPORT_QUERY)`; `null`, or a
   * window without `matchMedia`, tracks at every width.
   */
  compact?: CompactQuery | null;
}

export function mountPhoneDrawer(
  document: Document,
  signal: AbortSignal,
  effects: PhoneDrawerEffects = {
    opening: (inset) => dismissKeyboard(document, inset),
    opened: () => nativeHaptic("selection"),
  },
  options: PhoneDrawerOptions = {},
): () => void {
  if (signal.aborted) return () => {};

  const compact =
    options.compact !== undefined
      ? options.compact
      : (document.defaultView?.matchMedia?.(COMPACT_VIEWPORT_QUERY) ?? null);
  let stopTracking: (() => void) | null = null;
  const sync = () => {
    const active = compact === null || compact.matches;
    if (active && stopTracking === null) {
      stopTracking = trackShelves(document, effects);
    } else if (!active && stopTracking !== null) {
      stopTracking();
      stopTracking = null;
    }
  };
  sync();
  compact?.addEventListener("change", sync);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    compact?.removeEventListener("change", sync);
    stopTracking?.();
    stopTracking = null;
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}

function trackShelves(document: Document, effects: PhoneDrawerEffects): () => void {
  const page: Page = { inset: null, panel: null };
  for (const element of document.querySelectorAll(`${INSET}, ${PANEL}`)) {
    if (element.matches(INSET)) page.inset ??= element;
    else page.panel ??= element;
  }
  const startingCycle = (read: (page: Page) => ShelfReading): Cycle =>
    read(page) === "committed" ? "opened" : "closed";
  const cycles: Record<Shelf, Cycle> = {
    left: startingCycle(readLeftDrawer),
    right: startingCycle(readRightPanel),
  };

  const advance = (shelf: Shelf) => {
    const reading = SHELVES[shelf](page);
    if (reading === "closed" || reading === "none") {
      cycles[shelf] = "closed";
      return;
    }
    if (cycles[shelf] === "closed") {
      cycles[shelf] = "opening";
      effects.opening(page.inset);
    }
    if (reading === "committed" && cycles[shelf] === "opening") {
      cycles[shelf] = "opened";
      effects.opened();
    }
  };

  const applyRecord = (record: MutationRecord): boolean => {
    const { target, attributeName } = record;
    if (!(target instanceof Element)) return false;
    if (attributeName === PANEL_STATE) {
      if (target.getAttribute("data-testid") !== PANEL_TESTID) return false;
      // bb mounts the panel closed, so a new panel's first flip starts from closed.
      if (target !== page.panel) cycles.right = "closed";
      page.panel = target;
      return true;
    }
    if (attributeName === SHELF) {
      if (!target.matches(INSET)) return false;
      page.inset = target;
      return true;
    }
    return target === page.inset;
  };

  const handle = (records: MutationRecord[]) => {
    let changed = false;
    for (const record of records) {
      if (applyRecord(record)) changed = true;
    }
    if (!changed) return;
    if (page.inset?.isConnected !== true) page.inset = document.querySelector(INSET);
    if (page.panel?.isConnected !== true && slideOffset(page.inset) < 0) {
      // Only the right panel slides the page left. Find the panel bb mounted
      // since the last one went away; it may already be open, as after
      // rotating into compact width.
      page.panel = document.querySelector(PANEL);
      cycles.right = page.panel?.getAttribute(PANEL_STATE) === "full" ? "opened" : "closed";
    }
    advance("left");
    advance("right");
    wire();
  };

  const observer = new MutationObserver(handle);
  let wired = false;
  const observed: Page = { inset: null, panel: null };
  /** (Re)points the observer at the current page and panel, each without `subtree`. */
  function wire() {
    if (wired && observed.inset === page.inset && observed.panel === page.panel) return;
    const pending = wired ? observer.takeRecords() : [];
    observer.disconnect();
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: [SHELF, PANEL_STATE],
    });
    if (page.inset !== null) {
      observer.observe(page.inset, { attributes: true, attributeFilter: [ANIMATING, "style"] });
    }
    if (page.panel !== null) {
      observer.observe(page.panel, { attributes: true, attributeFilter: [PANEL_STATE] });
    }
    wired = true;
    observed.inset = page.inset;
    observed.panel = page.panel;
    if (pending.length > 0) handle(pending);
  }
  wire();

  return () => observer.disconnect();
}
