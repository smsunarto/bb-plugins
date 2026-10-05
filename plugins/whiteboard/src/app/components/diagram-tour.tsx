import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useReviewContainer } from "../vendor/review/app/src/review-root-context.tsx";
import { useRightPanelResize } from "../vendor/review/app/src/side-panel-resizer.ts";

export { DiagramTourOverlay } from "../vendor/review/app/src/diagram-tour.tsx";

/**
 * Upstream's tour shell (diagram-tour.tsx `useDiagramTourShell`) with focus
 * management. bb's chrome stays live beside the canvas, so the covered
 * document goes `inert` instead of trapping focus. Opening moves focus to
 * the active step, closing returns it to what opened the tour. The shell
 * takes Escape only from inside the overlay: upstream listened on window,
 * which in bb also caught Escape in the thread composer. flow-diagram.tsx, diagrams.tsx
 * and database-lens.tsx reach this through a redirect row.
 */
export function useDiagramTourShell(open: boolean, onClose: () => void) {
  // The resizer reads the ref; the effect below follows the element, so it
  // also undoes itself when an importer drops the overlay while `open` holds.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const attachOverlay = useCallback((element: HTMLDivElement | null) => {
    overlayRef.current = element;
    setOverlay(element);
  }, []);
  // The overlay portals into the canvas root, beside the theme host it covers.
  const portalTarget = useReviewContainer();

  const paneResize = useRightPanelResize({
    stateKey: "diagram-tour-pane-width",
    defaultWidth: 594,
    minWidth: 360,
    maxWidth: 760,
    minMainWidth: 480,
    separatorWidth: 10,
    label: "Resize tour pane",
    containerRef: overlayRef,
  });

  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!open || !overlay || !portalTarget) return;

    // Focus moves only when the reader is in the canvas: a tour restored on
    // mount must not pull focus out of bb's composer.
    const inCanvas = (element: Element | null) =>
      !element || element === document.body || portalTarget.contains(element);
    const opener = document.activeElement;
    const covered = portalTarget.querySelector<HTMLElement>(":scope > .review-theme-host");
    covered?.setAttribute("inert", "");

    // Lock the canvas scroller, as upstream does.
    const scroller = portalTarget.querySelector<HTMLElement>(".review-view-region--review");
    const originalOverflow = scroller?.style.overflow ?? "";
    if (scroller) scroller.style.overflow = "hidden";

    // Focusable overlay: a click on its background keeps focus (and Escape) inside.
    overlay.tabIndex = -1;
    const heading = overlay.querySelector<HTMLElement>(".tour-stop.active h3");
    if (heading) heading.tabIndex = -1;
    if (inCanvas(opener)) (heading ?? overlay).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.stopPropagation();
      close();
    };
    overlay.addEventListener("keydown", onKeyDown);

    return () => {
      overlay.removeEventListener("keydown", onKeyDown);
      if (scroller) scroller.style.overflow = originalOverflow;
      covered?.removeAttribute("inert");
      if (!inCanvas(document.activeElement)) return;
      // Without an opener in the canvas (a tour restored on mount while the
      // reader was in bb's composer, a removed diagram) the shell cannot tell
      // which figure owns the tour, so the canvas takes focus.
      const restore =
        opener instanceof HTMLElement && opener.isConnected && portalTarget.contains(opener)
          ? opener
          : portalTarget;
      restore.focus({ preventScroll: true });
    };
  }, [open, overlay, portalTarget]);

  return { overlayRef: attachOverlay, portalTarget, paneResize };
}
