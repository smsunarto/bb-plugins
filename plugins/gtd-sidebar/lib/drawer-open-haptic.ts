/**
 * Plays a light haptic once the phone drawer has fully opened. bb's sidebar
 * offers no open event, so this reads the two attributes bb sets on the page it
 * slides aside (`[data-sidebar="inset"]`):
 *
 * - `data-sidebar-shelf`: "open" or "closed" at compact width, absent on desktop.
 * - `data-vaul-animate`: present while bb drives the slide with inline styles.
 *
 * A tapped open slides with the shelf still "closed", then flips it to "open"
 * and drops `data-vaul-animate` in one task. A swipe flips the shelf at drag
 * start and keeps `data-vaul-animate` until the settle ends. Either way the
 * drawer is fully open when the shelf is "open" and nothing animates it. The
 * check reads the live element after each mutation batch, so a cancelled swipe,
 * which closes the shelf in the same task that clears the attribute, never
 * counts. The haptic fires once per closed → open cycle: dragging the open
 * drawer and letting it spring back stays silent.
 *
 * The attribute filter keeps the observer off streaming timeline text.
 */
import { nativeHaptic } from "./native-haptics";

const INSET = '[data-sidebar="inset"]';
const SHELF = "data-sidebar-shelf";
const ANIMATING = "data-vaul-animate";

type DrawerPhase = "closed" | "moving" | "open" | "none";

function drawerPhase(inset: Element): DrawerPhase {
  const shelf = inset.getAttribute(SHELF);
  if (shelf === null) return "none";
  if (inset.hasAttribute(ANIMATING)) return "moving";
  return shelf === "open" ? "open" : "closed";
}

export function mountDrawerOpenHaptic(
  document: Document,
  signal: AbortSignal,
  play: () => void = () => nativeHaptic("impact-light"),
): () => void {
  if (signal.aborted) return () => {};

  // Armed while the drawer has been seen closed since the last haptic.
  const initial = document.querySelector(INSET);
  let armed = initial === null || drawerPhase(initial) !== "open";

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
      armed = true;
    } else if (phase === "open" && armed) {
      armed = false;
      play();
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: [SHELF, ANIMATING],
  });

  const dispose = () => observer.disconnect();
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
