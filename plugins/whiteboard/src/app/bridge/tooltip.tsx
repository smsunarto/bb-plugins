import { useSyncExternalStore } from "react";
import type {
  ReviewDisposable,
  ReviewTooltipOptions,
} from "../../shared/vendor/review-protocol/src/index.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import type { Portals } from "./portals.tsx";

/**
 * `ReviewCanvasBridge.setupTooltip` as one shadcn Tooltip (design §3.8).
 *
 * Targets are DOM nodes the vendored canvas owns, so the tooltip anchors to a
 * fixed-position stand-in laid over the target's box. The stand-in lives in
 * `document.body`: `.review-canvas-root` uses container queries, which would
 * re-anchor a fixed descendant. `instant` shows at once (viewed box, diff
 * counts); otherwise the hover waits like bb's own tooltips.
 */
export const TOOLTIP_DELAY_MS = 500;

type Shown = {
  rect: { left: number; top: number; width: number; height: number };
  text: string;
  detail?: string;
};

function createTooltipStore() {
  let shown: Shown | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => shown,
    set(next: Shown | null) {
      shown = next;
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type TooltipStore = ReturnType<typeof createTooltipStore>;

function TooltipView({ store }: { store: TooltipStore }) {
  const shown = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!shown) return null;
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip open>
        <TooltipTrigger asChild>
          <span
            aria-hidden="true"
            data-wb-tooltip-anchor=""
            style={{
              position: "fixed",
              left: shown.rect.left,
              top: shown.rect.top,
              width: shown.rect.width,
              height: shown.rect.height,
              pointerEvents: "none",
            }}
          />
        </TooltipTrigger>
        <TooltipContent side="top" data-wb-tooltip="">
          <span className="block">{shown.text}</span>
          {shown.detail ? <span className="block opacity-70">{shown.detail}</span> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const PORTAL_ID = "whiteboard-tooltip";

export function createTooltips(
  portals: Portals,
): (target: HTMLElement, text: string, options?: ReviewTooltipOptions) => ReviewDisposable {
  const store = createTooltipStore();
  let anchorHost: HTMLElement | null = null;
  let unmountPortal: (() => void) | null = null;
  let owner: HTMLElement | null = null;
  let live = 0;

  const ensureHost = () => {
    if (anchorHost) return;
    anchorHost = document.createElement("div");
    anchorHost.dataset.wbTooltipHost = "";
    document.body.appendChild(anchorHost);
    unmountPortal = portals.mount({
      id: PORTAL_ID,
      container: anchorHost,
      element: <TooltipView store={store} />,
    });
  };
  const releaseHost = () => {
    unmountPortal?.();
    unmountPortal = null;
    anchorHost?.remove();
    anchorHost = null;
  };

  return (target, text, options = {}) => {
    live++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      if (!target.isConnected) return;
      ensureHost();
      const box = target.getBoundingClientRect();
      owner = target;
      store.set({
        rect: { left: box.left, top: box.top, width: box.width, height: box.height },
        text,
        ...(options.detail ? { detail: options.detail } : {}),
      });
    };
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      if (owner === target) {
        owner = null;
        store.set(null);
      }
    };
    const enter = () => {
      clearTimeout(timer);
      if (options.instant) show();
      else timer = setTimeout(show, TOOLTIP_DELAY_MS);
    };
    const events: Array<[string, () => void]> = [
      ["pointerenter", enter],
      ["pointerleave", hide],
      ["pointerdown", hide],
      ["focusin", enter],
      ["focusout", hide],
    ];
    for (const [type, handler] of events) target.addEventListener(type, handler);
    // The stand-in does not follow its target, so a scroll ends the hover.
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        hide();
        for (const [type, handler] of events) target.removeEventListener(type, handler);
        window.removeEventListener("scroll", hide, { capture: true });
        live--;
        if (live === 0) releaseHost();
      },
    };
  };
}
