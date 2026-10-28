import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * bb's thread stream panel. No SDK surface places plugin UI inside the stream
 * or reports its bounds, so the card reads the react-resizable-panels id
 * bb gives the stream or its split pane. Other hosts use the viewport bounds.
 */
const STREAM_PANEL_SELECTOR =
  '[data-panel-id="thread-detail-timeline-panel"], [data-split-pane-id]';
/** Gap between the card and the stream's header and edges. */
const INSET = 12;

export type StreamDockLayout = {
  width: number;
  top: number;
  right: number;
  maxHeight: number;
};

function findStreamPanel(trigger: Element | null): HTMLElement | null {
  return trigger?.closest<HTMLElement>(STREAM_PANEL_SELECTOR) ?? null;
}

function sameLayout(a: StreamDockLayout | null, b: StreamDockLayout | null) {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.width === b.width &&
      a.top === b.top &&
      a.right === b.right &&
      a.maxHeight === b.maxHeight)
  );
}

/**
 * Where the docked card sits: under the header, inset from the
 * stream's right edge, kept in step with resizes and bb's side panel.
 */
export function useStreamDock(anchor: RefObject<HTMLElement | null>) {
  const [layout, setLayout] = useState<StreamDockLayout | null>(null);
  useLayoutEffect(() => {
    const panel = findStreamPanel(anchor.current);
    const measure = () => {
      const box = panel?.getBoundingClientRect() ?? {
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const header = anchor.current?.closest("header");
      const top = (header ?? anchor.current)?.getBoundingClientRect().bottom ?? box.top;
      const insetTop = top + INSET;
      const next =
        box.width > INSET * 2
          ? {
              width: Math.min(280, box.width - INSET * 2),
              top: insetTop,
              right: Math.max(INSET, window.innerWidth - box.right + INSET),
              maxHeight: Math.max(
                0,
                Math.min(
                  box.bottom - insetTop - INSET,
                  box.width < 600 ? Math.min(120, box.height / 3) : Infinity,
                ),
              ),
            }
          : null;
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };
    measure();
    // Resizes cover the side panel and sidebars; a header that slides or fades in
    // moves the anchor without resizing anything, so settle again after an
    // animation on one of its ancestors ends.
    const settle = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(anchor.current)) measure();
    };
    const resize = new ResizeObserver(measure);
    if (panel) resize.observe(panel);
    const size = new MutationObserver(measure);
    if (panel) size.observe(panel, { attributes: true, attributeFilter: ["data-panel-size"] });
    const settled = ["animationend", "transitionend"] as const;
    for (const event of settled) window.addEventListener(event, settle, true);
    window.addEventListener("resize", measure);
    return () => {
      resize.disconnect();
      size.disconnect();
      for (const event of settled) window.removeEventListener(event, settle, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);
  return layout;
}
