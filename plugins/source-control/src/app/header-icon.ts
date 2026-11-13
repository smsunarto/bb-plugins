/**
 * The version-control icon on the thread header's Source Control button. bb
 * draws a header action as its label alone, so a content script adds the
 * icon to the button bb rendered. It reads no geometry, and after one pass
 * at mount it looks only at the nodes a mutation touched.
 */
const ACTIONS = "[data-thread-header-workflow-actions]";
const MARK = "data-sc-header-icon";
const SVG = "http://www.w3.org/2000/svg";
/** Lucide's git-branch. */
const SHAPES: [string, Record<string, string>][] = [
  ["line", { x1: "6", x2: "6", y1: "3", y2: "15" }],
  ["circle", { cx: "18", cy: "6", r: "3" }],
  ["circle", { cx: "6", cy: "18", r: "3" }],
  ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
];

function icon(document: Document): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  const attributes = {
    [MARK]: "",
    // bb's button sizes any `data-icon-root` child, as it does its own icons.
    "data-icon-root": "",
    "aria-hidden": "true",
    viewBox: "0 0 24 24",
    width: "16",
    height: "16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  for (const [tag, shape] of SHAPES) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(shape)) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}

/**
 * Keep the icon on every header button `isOurs` names by its label, until
 * `signal` aborts. Returns the disposer, which also takes the icons out.
 */
export function mountHeaderIcon(
  document: Document,
  signal: AbortSignal,
  isOurs: (label: string) => boolean,
): () => void {
  const view = document.defaultView;
  if (!view) return () => {};

  function decorate(actions: Element): void {
    for (const button of actions.querySelectorAll("button")) {
      const marked = button.querySelector(`:scope > [${MARK}]`);
      // The label is the button's text; the icon holds none.
      if (!isOurs(button.textContent.trim())) marked?.remove();
      else if (!marked) button.prepend(icon(document));
    }
  }

  function onMutations(records: MutationRecord[]): void {
    const touched = new Set<Element>();
    for (const record of records) {
      const inside = (record.target as Element).closest?.(ACTIONS);
      if (inside) {
        touched.add(inside);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const added = node as Element;
        if (added.matches(ACTIONS)) touched.add(added);
        else for (const actions of added.querySelectorAll(ACTIONS)) touched.add(actions);
      }
    }
    for (const actions of touched) decorate(actions);
  }

  const observer = new view.MutationObserver(onMutations);
  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    signal.removeEventListener("abort", dispose);
    for (const marked of document.querySelectorAll(`[${MARK}]`)) marked.remove();
  }
  signal.addEventListener("abort", dispose);
  // React resets a relabelled button's text, which drops the icon: both are child-list changes.
  observer.observe(document.body, { childList: true, subtree: true });
  for (const actions of document.querySelectorAll(ACTIONS)) decorate(actions);
  return dispose;
}
