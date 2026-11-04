export { cn } from "@bb-plugins/ui/utils";

/**
 * Scrolls `container` the least it takes to show `element`. Not
 * `scrollIntoView`, which would scroll bb's own layout too.
 */
export function keepInView(container: HTMLElement, element: HTMLElement): void {
  const box = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.top < box.top) container.scrollTop -= box.top - rect.top;
  else if (rect.bottom > box.bottom) container.scrollTop += rect.bottom - box.bottom;
}

/**
 * The nearest ancestor of `element` that actually scrolls: bb's sidebar when
 * the Inbox grows with its rows, or an inner list once it has a bounded height.
 */
export function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    if (/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}
