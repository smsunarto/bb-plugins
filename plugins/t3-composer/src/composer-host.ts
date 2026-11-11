/**
 * Marks BB's composer wrapper while this plugin's composer is mounted in it,
 * so the stylesheet targets the wrapper by attribute. The rules used an
 * ancestor `:has(> [data-composer-box] [data-t3-composer])` before: Chrome
 * re-checks such rules on DOM changes anywhere in the page, which made every
 * forced layout on a page with a composer several times dearer (a 300-file
 * diff scrolled at a 44 ms p95 instead of 19 ms).
 */

/** BB's wrappers around a composer box: a thread's follow-up composer and the new-thread page. */
const HOSTS = "[data-follow-up-composer], [data-app-composer]";

const marks = new WeakMap<Element, Map<string, number>>();

/** Sets `name` on `element` until every caller that set it has cleared it. */
function hold(element: Element, name: string): () => void {
  const counts = marks.get(element) ?? new Map<string, number>();
  marks.set(element, counts);
  counts.set(name, (counts.get(name) ?? 0) + 1);
  element.setAttribute(name, "");
  return () => {
    const left = (counts.get(name) ?? 1) - 1;
    if (left > 0) {
      counts.set(name, left);
      return;
    }
    counts.delete(name);
    element.removeAttribute(name);
  };
}

/**
 * The wrapper whose direct child box holds `node`: what the old
 * `:is(HOSTS):has(> [data-composer-box] node)` matched. Null elsewhere, such as
 * a composer outside BB's wrappers.
 */
export function composerHost(node: Element): Element | null {
  const box = node.closest("[data-composer-box]");
  const host = box?.parentElement ?? null;
  return host?.matches(HOSTS) ? host : null;
}

/** Marks the wrapper of `node` with `name` while mounted; returns the unmark. */
export function markComposerHost(node: Element | null, name: string): () => void {
  const host = node ? composerHost(node) : null;
  return host ? hold(host, name) : () => {};
}
