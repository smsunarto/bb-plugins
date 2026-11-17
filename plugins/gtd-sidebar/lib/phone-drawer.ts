/**
 * The phone drawer's two side effects, which bb's sidebar has no event for:
 *
 * - As the drawer starts to open, it dismisses the keyboard by blurring a
 *   focused text field on the page. The iOS keyboard is a system window that
 *   cannot slide aside with the page, so it would otherwise cover the drawer.
 * - Once the drawer commits to opening, it plays a selection tick, iOS's lightest
 *   haptic. A tapped open commits as its slide starts; a swipe commits on
 *   release, when bb starts settling it open. Waiting for the end of bb's 220ms
 *   settle made the tick land after the drawer had visibly arrived.
 *
 * It reads the two attributes bb sets on the page it slides aside
 * (`[data-sidebar="inset"]`):
 *
 * - `data-sidebar-shelf`: "open" or "closed" at compact width, absent on desktop.
 * - `data-vaul-animate`: present while bb drives the slide with inline styles.
 * - Its inline `translate` and `transition`: bb settles the slide with a
 *   `translate` transition toward the drawer's width (open) or `0px` (closed),
 *   and moves it with `transition: none` while a finger drags it.
 *
 * A tapped open slides with the shelf still "closed", then flips it to "open"
 * and drops `data-vaul-animate` in one task. A swipe flips the shelf at drag
 * start and keeps `data-vaul-animate` until the settle ends. Either way the
 * drawer is fully open when the shelf is "open" and nothing animates it; a
 * drawer that opens without a settle plays its tick then. Each
 * check reads the live element after a mutation batch, so a cancelled swipe,
 * which closes the shelf in the same task that clears the attribute, never
 * counts as open. Both effects run once per closed → open cycle: dragging the
 * open drawer and letting it spring back does neither.
 *
 * The attribute filter keeps the observer off streaming timeline text. During a
 * drag the inset's style changes every frame; each batch reads two inline
 * properties and no layout.
 */
import { nativeHaptic } from "./native-haptics";

const INSET = '[data-sidebar="inset"]';
const SHELF = "data-sidebar-shelf";
const ANIMATING = "data-vaul-animate";
const TEXT_FIELD = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

type DrawerPhase = "closed" | "moving" | "open" | "none";

function drawerPhase(inset: Element): DrawerPhase {
  const shelf = inset.getAttribute(SHELF);
  if (shelf === null) return "none";
  if (inset.hasAttribute(ANIMATING)) return "moving";
  return shelf === "open" ? "open" : "closed";
}

/** bb has started settling the slide toward open. */
function settlingOpen(inset: HTMLElement): boolean {
  const { transition, translate } = inset.style;
  return transition !== "" && transition !== "none" && Number.parseFloat(translate) > 0;
}

function dismissKeyboard(document: Document, inset: Element) {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && inset.contains(focused) && focused.matches(TEXT_FIELD)) {
    focused.blur();
  }
}

export interface PhoneDrawerEffects {
  /** The drawer has started to open. */
  opening: (inset: Element) => void;
  /** The drawer has committed to opening: settling open, or open without a settle. */
  opened: () => void;
}

export function mountPhoneDrawer(
  document: Document,
  signal: AbortSignal,
  effects: PhoneDrawerEffects = {
    opening: (inset) => dismissKeyboard(document, inset),
    opened: () => nativeHaptic("selection"),
  },
): () => void {
  if (signal.aborted) return () => {};

  // Where the drawer is in its closed → open cycle; reset only by closing.
  const initial = document.querySelector(INSET);
  let cycle: "closed" | "opening" | "opened" =
    initial !== null && drawerPhase(initial) === "open" ? "opened" : "closed";

  const observer = new MutationObserver((records) => {
    let inset: Element | null = null;
    for (const record of records) {
      if (record.target instanceof Element && record.target.matches(INSET)) {
        inset = record.target;
      }
    }
    if (inset === null) return;
    const phase = drawerPhase(inset);
    if (phase === "closed" || phase === "none") {
      cycle = "closed";
      return;
    }
    if (cycle === "closed") {
      cycle = "opening";
      effects.opening(inset);
    }
    const committed = phase === "open" || (inset instanceof HTMLElement && settlingOpen(inset));
    if (committed && cycle === "opening") {
      cycle = "opened";
      effects.opened();
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: [SHELF, ANIMATING, "style"],
  });

  const dispose = () => observer.disconnect();
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
