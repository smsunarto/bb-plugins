/**
 * Keeps the phone's capped navigation rows following the user:
 *
 * - While the drawer is closed, the rows start from the top with the active
 *   row in view, so the drawer opens on it. Closing the drawer resets them.
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

/** Scrolls the region to the top, then just far enough to show the active row. */
export function placeActiveRow(region: HTMLElement, activeItemId: string | null): void {
  region.scrollTop = 0;
  if (activeItemId === null) return;
  // Item ids are letters, digits, `-`, `_` and `/`, so they need no escaping.
  const active = region.querySelector<HTMLElement>(
    `[data-sidebar-navigation-item="${activeItemId}"]`,
  );
  if (active === null) return;
  // The region is the rows' offset parent.
  const bottom = active.offsetTop + active.offsetHeight;
  if (bottom > region.clientHeight) region.scrollTop = bottom - region.clientHeight;
}

export function markScrolled(event: UIEvent<HTMLElement>): void {
  const region = event.currentTarget;
  region.toggleAttribute(SCROLLED, region.scrollTop > 0);
}

export function revealFocusedRow(event: FocusEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) event.target.scrollIntoView({ block: "nearest" });
}

/** Ref for the scrolling region; places the active row whenever the drawer is closed. */
export function useNavScroll(activeItemId: string | null, isCompactViewport: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const region = ref.current;
    const inset = region?.ownerDocument.querySelector(INSET);
    if (!isCompactViewport || region === null || inset == null) return;
    let frame = 0;
    // One frame later, so the read follows React's commit and bb's own writes.
    const placeIfClosed = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (inset.getAttribute(SHELF) === "closed") placeActiveRow(region, activeItemId);
      });
    };
    placeIfClosed();
    const observer = new MutationObserver(placeIfClosed);
    observer.observe(inset, { attributes: true, attributeFilter: [SHELF] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [activeItemId, isCompactViewport]);

  return ref;
}
