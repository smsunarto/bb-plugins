/**
 * Lets a diff's code scroll sideways on a phone. bb's swipe-to-open-sidebar
 * gesture skips any horizontally scrollable ancestor of the touch, but a
 * diff's code scrolls inside the diff's shadow root, which that check cannot
 * see, so the gesture took the swipe. While a diff's code is wider than its
 * box, its wrapper carries bb's `data-no-sidebar-swipe`, as bb does on its own
 * for scrollers it can see; code that fits leaves the sidebar swipe alone.
 */

/** bb's mobile sidebar swipe ignores a touch inside an element with this attribute. */
export const NO_SIDEBAR_SWIPE = "data-no-sidebar-swipe";

type Box = { scrollWidth: number; clientWidth: number };

/** Whether a scroller holds more than its width: bb's own test, a pixel of slack included. */
export function overflowsX(box: Box): boolean {
  return box.scrollWidth > box.clientWidth + 1;
}

/** Whether any diff inside `root` has code wider than its box. */
export function codeOverflows(root: ParentNode): boolean {
  for (const host of root.querySelectorAll("diffs-container"))
    for (const code of host.shadowRoot?.querySelectorAll<HTMLElement>("code[data-code]") ?? [])
      if (overflowsX(code)) return true;
  return false;
}

function mark(wrapper: Element): void {
  wrapper.toggleAttribute(NO_SIDEBAR_SWIPE, codeOverflows(wrapper));
}

let shared: ResizeObserver | null = null;
/** One observer for every diff: it calls back after layout, so reading widths there forces none. */
function observer(): ResizeObserver {
  shared ??= new ResizeObserver((entries) => {
    for (const entry of entries) mark(entry.target);
  });
  return shared;
}

/**
 * A ref for the element that wraps a diff. A diff resizes when its code
 * renders, expands or rewraps, so its overflow is read again then.
 */
export function guardCodeSwipe(wrapper: HTMLElement | null): (() => void) | undefined {
  if (!wrapper || typeof ResizeObserver === "undefined") return undefined;
  observer().observe(wrapper);
  return () => {
    observer().unobserve(wrapper);
    wrapper.removeAttribute(NO_SIDEBAR_SWIPE);
  };
}
