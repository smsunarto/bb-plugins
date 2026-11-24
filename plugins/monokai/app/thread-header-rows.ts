import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

const COMPACT = "(max-width: 767px)";
const ROWS = "[data-thread-header-rows]";
const EMPTY = "data-monokai-empty-thread-header-rows";

// The header-row slot supplies its pane's marker when it mounts. Keep these
// refs across breakpoint changes so we never have to search for panes in the DOM.
const markers = new Set<HTMLSpanElement>();
let onMarkerChange: ((marker: HTMLSpanElement, mounted: boolean) => void) | undefined;

export function registerThreadHeaderMarker(marker: HTMLSpanElement | null) {
  if (!marker) return;
  markers.add(marker);
  onMarkerChange?.(marker, true);
  return () => {
    markers.delete(marker);
    onMarkerChange?.(marker, false);
  };
}

function observeCompactRows() {
  const observed = new Map<HTMLSpanElement, Element>();
  const resize = new ResizeObserver((entries) => {
    for (const { target, borderBoxSize, contentRect } of entries) {
      const height = borderBoxSize[0]?.blockSize ?? contentRect.height;
      target.toggleAttribute(EMPTY, height === 0);
    }
  });
  onMarkerChange = (marker, mounted) => {
    if (mounted) {
      const rows = marker.closest(ROWS);
      if (!rows) return;
      observed.set(marker, rows);
      resize.observe(rows, { box: "border-box" });
      return;
    }

    const rows = observed.get(marker);
    if (!rows) return;
    observed.delete(marker);
    resize.unobserve(rows);
    rows.removeAttribute(EMPTY);
  };

  for (const marker of markers) onMarkerChange(marker, true);
  return () => {
    onMarkerChange = undefined;
    resize.disconnect();
    for (const rows of observed.values()) rows.removeAttribute(EMPTY);
    observed.clear();
  };
}

/** Measure the slot container rather than counting contributors, which can all be invisible. */
export function mountThreadHeaderRows({ signal }: Pick<PluginContentScriptContext, "signal">) {
  if (signal.aborted) return;

  const media = window.matchMedia(COMPACT);
  let stop: (() => void) | undefined;
  const syncViewport = () => {
    if (media.matches) {
      stop ??= observeCompactRows();
      return;
    }
    stop?.();
    stop = undefined;
  };

  syncViewport();
  media.addEventListener("change", syncViewport);
  const dispose = () => {
    media.removeEventListener("change", syncViewport);
    signal.removeEventListener("abort", dispose);
    stop?.();
    stop = undefined;
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
