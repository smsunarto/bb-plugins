import { useEffect, useState, type RefObject } from "react";

// Identify the owning stream only for panel visibility; CSS positions the card
// against its existing header, without measuring the stream or the viewport.
const STREAM_PANEL_SELECTOR =
  '[data-panel-id="thread-detail-timeline-panel"], [data-split-pane-id]';
// BB keeps closed desktop panels mounted; compact panels live in a dialog portal.
const RIGHT_PANEL_SELECTOR = '[id^="thread-detail-secondary-panel"] > aside[aria-hidden]';
const DRAWER_PANEL_SELECTOR = '[role="dialog"] aside[aria-hidden]';
const DRAWER_SELECTOR =
  '[role="dialog"][data-state]:not([data-state="closed"]) aside[aria-hidden="false"]';
function findStreamPanel(trigger: Element | null): HTMLElement | null {
  return trigger?.closest<HTMLElement>(STREAM_PANEL_SELECTOR) ?? null;
}

/** Resolve the existing header and panel visibility without reading layout. */
export function useStreamDock(anchor: RefObject<HTMLElement | null>) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const panel = findStreamPanel(anchor.current);
    const group = panel?.closest("[data-panel-group]") ?? panel;
    const paneId = panel?.dataset.splitPaneId;
    const updateVisibility = () => {
      const rightPanelOpen = [...(group?.querySelectorAll(RIGHT_PANEL_SELECTOR) ?? [])].some(
        (aside) =>
          aside.getAttribute("aria-hidden") === "false" &&
          (aside.parentElement?.id === "thread-detail-secondary-panel" ||
            (paneId && aside.parentElement?.id === `thread-detail-secondary-panel-${paneId}`)),
      );
      if (rightPanelOpen || document.querySelector(DRAWER_SELECTOR)) {
        setTarget((previous) => (previous === null ? previous : null));
        return;
      }
      const collapsed =
        panel?.getAttribute("data-panel-size") === "0.0" ||
        panel?.getAttribute("data-panel-size") === "0";
      setTarget(
        collapsed
          ? null
          : (anchor.current?.closest<HTMLElement>("[data-split-pane-id][data-focused]") ??
              anchor.current?.closest<HTMLElement>("header") ??
              document.body),
      );
    };
    updateVisibility();
    const visibility = new MutationObserver((records) => {
      const relevant = `${RIGHT_PANEL_SELECTOR}, ${DRAWER_PANEL_SELECTOR}, [role="dialog"]`;
      if (
        records.some((record) =>
          record.type === "attributes"
            ? record.target instanceof Element &&
              (record.target.matches(relevant) || record.target === panel)
            : [...record.addedNodes, ...record.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches(relevant) || node.querySelector(relevant)),
              ),
        )
      )
        updateVisibility();
    });
    visibility.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "data-state", "data-panel-size"],
    });
    return () => visibility.disconnect();
  }, [anchor]);
  return target;
}
