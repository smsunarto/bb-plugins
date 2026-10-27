import {
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

/**
 * bb's thread stream panel. No SDK surface places plugin UI inside the stream
 * or reports bb's side panel, so the card reads bb's own DOM: the
 * react-resizable-panels id bb gives the stream, and the size that panel
 * shrinks to when the side panel opens. Without the panel (split-pane hosting,
 * a bb that renamed it) the card falls back to a popover on the header button.
 */
const STREAM_PANEL_SELECTOR = '[data-panel-id="thread-detail-timeline-panel"]';
/** Below this width the stream is collapsed or too narrow to float a card over. */
const MIN_STREAM_WIDTH = 320;
/** Gap between the card and the stream's header and edges. */
const INSET = 12;

export type StreamDockLayout = {
  /** bb's side panel shares the row, so the card is hidden unless peeked. */
  crowded: boolean;
  top: number;
  right: number;
  maxHeight: number;
};

function findStreamPanel(trigger: Element | null): HTMLElement | null {
  return trigger?.closest<HTMLElement>(STREAM_PANEL_SELECTOR) ?? null;
}

function isCrowded(panel: HTMLElement) {
  return Number(panel.dataset.panelSize ?? 100) < 99.5;
}

/** A stream with room to float the card over; a collapsed conversation has no width. */
function fitsCard(panel: HTMLElement) {
  return panel.getBoundingClientRect().width >= MIN_STREAM_WIDTH;
}

function sameLayout(a: StreamDockLayout | null, b: StreamDockLayout | null) {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.crowded === b.crowded &&
      a.top === b.top &&
      a.right === b.right &&
      a.maxHeight === b.maxHeight)
  );
}

/**
 * Where the docked card sits: under the header button, inset from the
 * stream's right edge, kept in step with resizes and bb's side panel.
 */
function useStreamDock(trigger: RefObject<HTMLElement | null>, enabled: boolean) {
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState<StreamDockLayout | null>(null);
  const resolve = useCallback(() => {
    const found = enabled ? findStreamPanel(trigger.current) : null;
    setPanel(found);
    return found;
  }, [enabled, trigger]);
  useLayoutEffect(() => void resolve(), [resolve]);
  useLayoutEffect(() => {
    if (!panel) {
      setLayout(null);
      return;
    }
    const measure = () => {
      const box = panel.getBoundingClientRect();
      const top = (trigger.current?.getBoundingClientRect().bottom ?? box.top) + INSET;
      const next = fitsCard(panel)
        ? {
            crowded: isCrowded(panel),
            top,
            right: Math.max(INSET, window.innerWidth - box.right + INSET),
            maxHeight: Math.max(0, box.bottom - top - INSET),
          }
        : null;
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };
    measure();
    // Resizes cover the side panel and sidebars; a header that slides or fades in
    // moves the button without resizing anything, so settle again after an
    // animation on one of its ancestors ends.
    const settle = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(trigger.current)) measure();
    };
    const resize = new ResizeObserver(measure);
    resize.observe(panel);
    const size = new MutationObserver(measure);
    size.observe(panel, { attributes: true, attributeFilter: ["data-panel-size"] });
    const settled = ["animationend", "transitionend"] as const;
    for (const event of settled) window.addEventListener(event, settle, true);
    window.addEventListener("resize", measure);
    return () => {
      resize.disconnect();
      size.disconnect();
      for (const event of settled) window.removeEventListener(event, settle, true);
      window.removeEventListener("resize", measure);
    };
  }, [panel, trigger]);
  return { layout, resolve };
}

/** Whether the card is pinned to the stream; shared by every pane and window, like t3code. */
const PINNED_KEY = "kitchen-sink:thread-details:pinned";
const pinnedListeners = new Set<() => void>();
/** Used where storage is unavailable, so the toggle still works for this window. */
let pinnedFallback = true;

function readPinned() {
  try {
    return localStorage.getItem(PINNED_KEY) !== "false";
  } catch {
    return pinnedFallback;
  }
}

function subscribePinned(listener: () => void) {
  pinnedListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    pinnedListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function setPinned(pinned: boolean) {
  pinnedFallback = pinned;
  try {
    localStorage.setItem(PINNED_KEY, String(pinned));
  } catch {
    // readPinned falls back to pinnedFallback.
  }
  for (const listener of pinnedListeners) listener();
}

function usePinned() {
  return useSyncExternalStore(subscribePinned, readPinned, () => true);
}

/**
 * Whether the card shows. Docked, it follows the pinned preference; opening
 * bb's side panel hides it, and the button then peeks at it without
 * unpinning, as in t3code. Without a stream to dock in (phones, split-pane
 * hosting, a narrow stream) the button opens a popover instead.
 */
export function useCardVisibility(trigger: RefObject<HTMLElement | null>, dockable: boolean) {
  const { layout, resolve } = useStreamDock(trigger, dockable);
  const pinned = usePinned();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const crowded = layout?.crowded ?? false;
  const [peekCrowded, setPeekCrowded] = useState(crowded);
  if (peekCrowded !== crowded) {
    setPeekCrowded(crowded);
    setPeek(false);
  }
  // A popover left open when the card docks must not reopen when the stream narrows again.
  const [wasDocked, setWasDocked] = useState(layout !== null);
  if (wasDocked !== (layout !== null)) {
    setWasDocked(layout !== null);
    setPopoverOpen(false);
  }
  const docked = crowded ? peek : pinned;
  const toggle = () => {
    const panel = resolve();
    if (!panel || !fitsCard(panel)) setPopoverOpen((value) => !value);
    else if (isCrowded(panel)) setPeek((value) => !value);
    else setPinned(!pinned);
  };
  return { layout, open: layout ? docked : popoverOpen, popoverOpen, setPopoverOpen, toggle };
}
