/**
 * Keeps the phone's capped navigation rows following the user:
 *
 * - While the drawer is closed, the rows start from the top with the active
 *   row in view, so the drawer opens on it. Closing the drawer resets them.
 * - Each time the drawer opens, the active row is brought into view again
 *   against the current height, which a resize while closed may have changed.
 * - A focused row scrolls into view.
 * - The region marks each edge that has more rows beyond it.
 *
 * The drawer's state is bb's `data-sidebar-shelf` attribute on the page it
 * slides aside (`[data-sidebar="inset"]`): "open" or "closed" at compact width,
 * absent on desktop, where nothing here runs.
 */
import { useEffect, useRef, type FocusEvent, type UIEvent } from "react";

const INSET = '[data-sidebar="inset"]';
const SHELF = "data-sidebar-shelf";
const SCROLLED = "data-gtd-nav-scrolled";
const MORE_BELOW = "data-gtd-nav-more-below";

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

function updateScrollEdges(region: HTMLElement): void {
  const { scrollTop, scrollHeight, clientHeight } = region;
  region.toggleAttribute(SCROLLED, scrollTop > 1);
  region.toggleAttribute(MORE_BELOW, scrollHeight - clientHeight - scrollTop > 1);
}

export function markScrolled(event: UIEvent<HTMLElement>): void {
  updateScrollEdges(event.currentTarget);
}

export function revealFocusedRow(event: FocusEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) event.target.scrollIntoView({ block: "nearest" });
}

/** Ref for the scrolling region; places the active row as the drawer closes and opens. */
export function useNavScroll(activeItemId: string | null, isPhone: boolean, rowCount: number) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const region = ref.current;
    if (!isPhone || region === null) return;
    const inset = region.ownerDocument.querySelector(INSET);
    let frame = 0;
    // One frame later, so the read follows React's commit and bb's own writes.
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const shelf = inset?.getAttribute(SHELF);
        if (shelf === "closed") placeActiveRow(region, activeItemId, true);
        else if (shelf === "open") placeActiveRow(region, activeItemId, false);
        updateScrollEdges(region);
      });
    };
    place();
    const observer = new MutationObserver(place);
    if (inset !== null) observer.observe(inset, { attributes: true, attributeFilter: [SHELF] });
    // A viewport resize can change the number of full rows that fit.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => updateScrollEdges(region));
    resizeObserver?.observe(region);
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [activeItemId, isPhone, rowCount]);

  return ref;
}
