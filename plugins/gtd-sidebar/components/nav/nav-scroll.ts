/**
 * Keeps the phone's capped navigation rows following the user:
 *
 * - While the drawer is closed, the rows start from the top with the active
 *   row in view, so the drawer opens on it. Closing the drawer resets them.
 * - Each time the drawer opens, the active row is brought into view again
 *   against the current height, which a resize while closed may have changed.
 * - A focused row scrolls into view.
 * - Once scrolled, the region carries `data-gtd-nav-scrolled`, which fades its
 *   top edge.
 *
 * The drawer's state is bb's `data-sidebar-shelf` attribute on the page it
 * slides aside (`[data-sidebar="inset"]`): "open" or "closed" at compact width,
 * absent on desktop, where nothing here runs.
 */
import { useEffect, useRef, type FocusEvent, type UIEvent } from "react";

const INSET = '[data-sidebar="inset"]';
const SHELF = "data-sidebar-shelf";
const SCROLLED = "data-gtd-nav-scrolled";

/**
 * Scrolls just far enough to show the active row: from the top when `reset`,
 * from where the rows are otherwise.
 */
export function placeActiveRow(
  region: HTMLElement,
  activeItemId: string | null,
  reset: boolean,
): void {
  if (reset) region.scrollTop = 0;
  if (activeItemId === null) return;
  // Item ids are letters, digits, `-`, `_` and `/`, so they need no escaping.
  const active = region.querySelector<HTMLElement>(
    `[data-sidebar-navigation-item="${activeItemId}"]`,
  );
  if (active === null) return;
  // The region is the rows' offset parent.
  const top = active.offsetTop;
  const bottom = top + active.offsetHeight;
  if (top < region.scrollTop) region.scrollTop = top;
  else if (bottom > region.scrollTop + region.clientHeight) {
    region.scrollTop = bottom - region.clientHeight;
  }
}

export function markScrolled(event: UIEvent<HTMLElement>): void {
  const region = event.currentTarget;
  region.toggleAttribute(SCROLLED, region.scrollTop > 0);
}

export function revealFocusedRow(event: FocusEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) event.target.scrollIntoView({ block: "nearest" });
}

/** Ref for the scrolling region; places the active row as the drawer closes and opens. */
export function useNavScroll(activeItemId: string | null, isCompactViewport: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const region = ref.current;
    if (!isCompactViewport || region === null) return;
    const inset = region.ownerDocument.querySelector(INSET);
    if (inset === null) return;
    let frame = 0;
    // One frame later, so the read follows React's commit and bb's own writes.
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const shelf = inset.getAttribute(SHELF);
        if (shelf === "closed") placeActiveRow(region, activeItemId, true);
        else if (shelf === "open") placeActiveRow(region, activeItemId, false);
      });
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(inset, { attributes: true, attributeFilter: [SHELF] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [activeItemId, isCompactViewport]);

  return ref;
}
