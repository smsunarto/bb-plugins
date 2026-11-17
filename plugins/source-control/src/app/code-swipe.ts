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

/** The wrapper each observed element answers for: the wrapper itself, or a diff's code inside it. */
const owners = new WeakMap<Element, Element>();
/** The code elements observed for each wrapper, let go with it. */
const codes = new WeakMap<Element, Set<Element>>();

let shared: ResizeObserver | null = null;
/** One observer for every diff: it calls back after layout, so reading widths there forces none. */
function observer(): ResizeObserver {
  shared ??= new ResizeObserver((entries) => {
    const wrappers = new Set<Element>();
    for (const entry of entries) {
      const wrapper = owners.get(entry.target);
      if (wrapper) wrappers.add(wrapper);
    }
    for (const wrapper of wrappers) mark(wrapper);
  });
  return shared;
}

/**
 * A ref for the element that wraps a diff. A diff resizes when its code
 * renders, expands or rewraps, so its overflow is read again then.
 */
export function guardCodeSwipe(wrapper: HTMLElement | null): (() => void) | undefined {
  if (!wrapper || typeof ResizeObserver === "undefined") return undefined;
  owners.set(wrapper, wrapper);
  observer().observe(wrapper);
  return () => {
    observer().unobserve(wrapper);
    for (const code of codes.get(wrapper) ?? []) observer().unobserve(code);
    codes.delete(wrapper);
    owners.delete(wrapper);
    wrapper.removeAttribute(NO_SIDEBAR_SWIPE);
  };
}

/**
 * A diff's `onPostRender`. A virtualized diff keeps its full height while it
 * renders other rows, so a wide line scrolled into view resizes nothing the
 * wrapper's observer sees. Observing the code afresh delivers one callback
 * after the next layout, which reads the new width there.
 */
export function recheckCodeSwipe(host: HTMLElement, _diff?: unknown, phase?: string): void {
  if (phase === "unmount" || typeof ResizeObserver === "undefined") return;
  let wrapper: Element | null = host.parentElement;
  while (wrapper && owners.get(wrapper) !== wrapper) wrapper = wrapper.parentElement;
  if (!wrapper) return;
  let seen = codes.get(wrapper);
  if (!seen) codes.set(wrapper, (seen = new Set()));
  for (const code of seen)
    if (!code.isConnected) {
      observer().unobserve(code);
      seen.delete(code);
    }
  for (const code of host.shadowRoot?.querySelectorAll("code[data-code]") ?? []) {
    owners.set(code, wrapper);
    seen.add(code);
    observer().unobserve(code);
    observer().observe(code);
  }
}
