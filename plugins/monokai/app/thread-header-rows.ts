import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const ROWS = "[data-thread-header-rows]";
const EMPTY = "data-monokai-empty-thread-header-rows";
const PANE_CONTENT = `[data-thread-window], ${ROWS}`;

/** bb inserts a row container even when every registered slot renders nothing. */
export function mountThreadHeaderRows({ signal }: Pick<PluginContentScriptContext, "signal">) {
  if (signal.aborted) return;

  const observed = new Set<Element>();
  const resize = new ResizeObserver((entries) => {
    for (const { target, borderBoxSize, contentRect } of entries) {
      const height = borderBoxSize[0]?.blockSize ?? contentRect.height;
      target.toggleAttribute(EMPTY, height === 0);
    }
  });
  const observe = (rows: Element) => {
    if (!rows.isConnected || observed.has(rows)) return;
    observed.add(rows);
    resize.observe(rows, { box: "border-box" });
  };

  const mutations = new MutationObserver((records) => {
    let removedNodes = false;
    for (const { target, addedNodes, removedNodes: removed } of records) {
      // Slot rows are peers of the thread window. Streamed transcript updates
      // and changes inside an observed row cannot add or remove this peer.
      if (target instanceof Element && target.closest(PANE_CONTENT)) continue;
      removedNodes ||= removed.length > 0;
      for (const node of addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(ROWS)) observe(node);
        if (node.childElementCount > 0) node.querySelectorAll(ROWS).forEach(observe);
      }
    }
    if (!removedNodes) return;
    for (const rows of observed) {
      if (rows.isConnected) continue;
      resize.unobserve(rows);
      rows.removeAttribute(EMPTY);
      observed.delete(rows);
    }
  });

  document.querySelectorAll(ROWS).forEach(observe);
  mutations.observe(document, { childList: true, subtree: true });

  const dispose = () => {
    mutations.disconnect();
    resize.disconnect();
    for (const rows of observed) rows.removeAttribute(EMPTY);
    observed.clear();
    signal.removeEventListener("abort", dispose);
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
