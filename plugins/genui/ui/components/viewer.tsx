// The one full-screen viewer every picture opens in (Image, Gallery,
// ImageSearch, Entity, Hotspots, OptionCards, Compare, evidence images) and
// that diagrams open in, plus the pan and zoom it shares with the inline
// diagram: wheel and trackpad pinch, drag, two-finger pinch, double tap.
// The geometry is zoomMath.ts.
//
// Touch goes through touch events, not pointer events: a browser cancels the
// pointers of a gesture it starts handling itself (a scroll beginning under
// two fingers), while touch events keep coming and can still be cancelled,
// which is also what stops iOS from zooming the whole page instead.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Size } from "../../core/compare";
import { usePaneBounds } from "../paneBounds";
import { useUiRuntime } from "../runtime";
import { EASE_OUT_EXPO, reducedMotion, useMotionScope } from "./motion";
import {
  clampView,
  FIT_VIEW,
  panBy,
  pinchView,
  placeImage,
  toggleZoom,
  wheelZoomFactor,
  zoomAround,
  type Placement,
  type Point,
  type View,
} from "./zoomMath";

/** One picture the viewer can show. */
export interface Viewable {
  readonly url: string;
  readonly alt: string;
  readonly caption: string | null;
  /** Under the caption: a found photo's credit. */
  readonly credit?: ReactNode;
  /** A file of the thread, which the viewer offers to open in BB. */
  readonly path?: string;
}

/** The pane in client coordinates (as laid out, before any zoom) and the content's size at zoom 1. */
export interface PaneBox {
  readonly left: number;
  readonly top: number;
  readonly pane: Size;
  readonly content: Size;
}

interface PanZoomOptions {
  /** Where the pane and its content are now; null while there is nothing to zoom. */
  readonly measure: () => PaneBox | null;
  /** Draws the content at a placement (pane coordinates, scale per content pixel). */
  readonly draw: (placed: Placement, view: View) => void;
  /** Full screen, a plain wheel zooms; inline it scrolls the thread, and only a pinch or ⌘/Ctrl + wheel zooms. */
  readonly plainWheel: boolean;
  /** Double tap or double click zooms in at the point, or back to fit. */
  readonly doubleTap: boolean;
  /** A one-finger swipe while fitted (the viewer steps or closes on it). */
  readonly onSwipe?: (dx: number, dy: number) => void;
}

export interface PanZoom {
  readonly zoomed: boolean;
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
  /** Draws the current view again after the pane or the content changed size. */
  readonly redraw: () => void;
}

/** How far a press may travel and still be a tap. */
const TAP_SLOP_PX = 8;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 32;
const ZOOMED = 1.001;

type Gesture =
  | { readonly kind: "pinch"; readonly ids: readonly [number, number]; readonly from: readonly [Point, Point]; readonly start: View; readonly box: PaneBox }
  | { readonly kind: "pan"; readonly id: number; last: Point; readonly box: PaneBox }
  | { readonly kind: "press"; readonly id: number; readonly start: Point };

/** Safari's trackpad pinch on macOS: no ctrl+wheel, a scale on gesture events instead. */
interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Attributes that keep BB's mobile sidebar and side-panel swipes off an
 * element: BB's swipe recognizers skip touches that start inside them. Every
 * surface a finger drags or pinches needs them, or a sideways pan (or the
 * outer finger of a pinch) opens a panel instead.
 */
export const NO_BB_SWIPE = { "data-no-sidebar-swipe": "", "data-no-secondary-panel-swipe": "" } as const;

/**
 * Pan and zoom of `surface`'s content. The caller says where the pane is and
 * draws; the view lives here, in a ref, so a gesture draws every frame
 * without rendering React. `zoomed` is state, for touch-action and controls.
 */
export function usePanZoom(surface: HTMLElement | null, options: PanZoomOptions): PanZoom {
  const latest = useRef(options);
  latest.current = options;
  const view = useRef<View>(FIT_VIEW);
  const [zoomed, setZoomed] = useState(false);

  const show = useCallback((next: View, box: PaneBox | null = latest.current.measure()) => {
    if (box === null) return;
    const shown = clampView(next, box.pane, box.content);
    view.current = shown;
    latest.current.draw(placeImage(shown, box.pane, box.content), shown);
    setZoomed(shown.zoom > ZOOMED);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const box = latest.current.measure();
      if (box !== null) show(zoomAround(view.current, factor, { x: box.pane.width / 2, y: box.pane.height / 2 }, box.pane, box.content), box);
    },
    [show],
  );
  const reset = useCallback(() => show(FIT_VIEW), [show]);
  const redraw = useCallback(() => show(view.current), [show]);

  useEffect(() => {
    if (surface === null) return;
    let gesture: Gesture | null = null;
    let travel = 0;
    // A drag or pinch ends in a click the content must not take as a tap.
    let swallowClick = false;
    let lastTap: { readonly time: number; readonly at: Point } | null = null;
    let mouse: { readonly id: number; last: Point; readonly box: PaneBox } | null = null;
    let safari: { readonly start: View; readonly scale: number } | null = null;
    // Browsers follow a double tap with a dblclick of their own, which would toggle the zoom back.
    let touchedAt = Number.NEGATIVE_INFINITY;

    const local = (box: PaneBox, point: Point): Point => ({ x: point.x - box.left, y: point.y - box.top });
    const fingers = (event: TouchEvent) =>
      [...event.touches]
        .filter((touch) => touch.target instanceof Node && surface.contains(touch.target))
        .map((touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));

    const begin = (list: readonly { id: number; x: number; y: number }[]) => {
      const box = latest.current.measure();
      if (box === null || list.length === 0) {
        gesture = null;
        return;
      }
      if (list.length >= 2) {
        const [a, b] = list as [{ id: number; x: number; y: number }, { id: number; x: number; y: number }];
        gesture = { kind: "pinch", ids: [a.id, b.id], from: [local(box, a), local(box, b)], start: view.current, box };
      } else if (view.current.zoom > ZOOMED) {
        gesture = { kind: "pan", id: list[0]!.id, last: list[0]!, box };
      } else {
        gesture = { kind: "press", id: list[0]!.id, start: list[0]! };
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      const list = fingers(event);
      if (list.length === 1) {
        // A new press: whatever the last gesture swallowed (a touch drag ends without a click) is over.
        travel = 0;
        swallowClick = false;
      }
      // Two fingers are ours: no page zoom, no scroll under them.
      if (list.length >= 2 && event.cancelable) event.preventDefault();
      begin(list);
    };

    const onTouchMove = (event: TouchEvent) => {
      const current = gesture;
      if (current === null) return;
      const list = fingers(event);
      if (current.kind === "pinch") {
        const a = list.find((finger) => finger.id === current.ids[0]);
        const b = list.find((finger) => finger.id === current.ids[1]);
        if (a === undefined || b === undefined) return;
        if (event.cancelable) event.preventDefault();
        travel += TAP_SLOP_PX;
        show(pinchView(current.start, current.from, [local(current.box, a), local(current.box, b)], current.box.pane, current.box.content), current.box);
        return;
      }
      const finger = list.find((candidate) => candidate.id === current.id);
      if (finger === undefined) return;
      if (current.kind === "pan") {
        if (event.cancelable) event.preventDefault();
        travel += Math.hypot(finger.x - current.last.x, finger.y - current.last.y);
        show(panBy(view.current, finger.x - current.last.x, finger.y - current.last.y, current.box.pane, current.box.content), current.box);
        current.last = finger;
      } else {
        travel = Math.max(travel, Math.hypot(finger.x - current.start.x, finger.y - current.start.y));
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      touchedAt = event.timeStamp;
      const current = gesture;
      const list = fingers(event);
      if (list.length > 0) {
        // A pinch that lost a finger carries on as a pan of the one left.
        if (current?.kind === "pinch") begin(list.slice(0, 1));
        return;
      }
      gesture = null;
      const ended = event.changedTouches[0];
      if (current === null || ended === undefined) return;
      const at = { x: ended.clientX, y: ended.clientY };
      if (travel >= TAP_SLOP_PX || current.kind === "pinch") {
        swallowClick = current.kind !== "press";
        lastTap = null;
        if (current.kind === "press" && event.type === "touchend") latest.current.onSwipe?.(at.x - current.start.x, at.y - current.start.y);
        return;
      }
      if (!latest.current.doubleTap) return;
      const now = event.timeStamp;
      if (lastTap !== null && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(at.x - lastTap.at.x, at.y - lastTap.at.y) < DOUBLE_TAP_PX) {
        lastTap = null;
        const box = latest.current.measure();
        if (box !== null) show(toggleZoom(view.current, local(box, at), box.pane, box.content), box);
        return;
      }
      lastTap = { time: now, at };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      swallowClick = false;
      if (event.button !== 0 || view.current.zoom <= ZOOMED) return;
      const box = latest.current.measure();
      if (box === null) return;
      travel = 0;
      mouse = { id: event.pointerId, last: { x: event.clientX, y: event.clientY }, box };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (mouse === null || mouse.id !== event.pointerId) return;
      const dx = event.clientX - mouse.last.x;
      const dy = event.clientY - mouse.last.y;
      travel += Math.hypot(dx, dy);
      // Captured only once it is a drag, so a plain click still reaches what is under it.
      if (travel >= TAP_SLOP_PX && !surface.hasPointerCapture(event.pointerId)) surface.setPointerCapture(event.pointerId);
      mouse.last = { x: event.clientX, y: event.clientY };
      show(panBy(view.current, dx, dy, mouse.box.pane, mouse.box.content), mouse.box);
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (mouse === null || mouse.id !== event.pointerId) return;
      mouse = null;
      if (travel >= TAP_SLOP_PX) swallowClick = true;
    };

    const onClick = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (!latest.current.doubleTap || event.timeStamp - touchedAt < 1000) return;
      const box = latest.current.measure();
      if (box === null) return;
      event.preventDefault();
      show(toggleZoom(view.current, local(box, { x: event.clientX, y: event.clientY }), box.pane, box.content), box);
    };

    const onWheel = (event: WheelEvent) => {
      const box = latest.current.measure();
      if (box === null) return;
      const at = local(box, { x: event.clientX, y: event.clientY });
      if (event.ctrlKey || event.metaKey || latest.current.plainWheel) {
        event.preventDefault();
        show(zoomAround(view.current, wheelZoomFactor(event.deltaY, event.deltaMode, box.pane.height), at, box.pane, box.content), box);
        return;
      }
      if (view.current.zoom <= ZOOMED) return;
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.pane.height : 1;
      const next = panBy(view.current, -event.deltaX * lines, -event.deltaY * lines, box.pane, box.content);
      // At an edge the page scrolls on, as everywhere else in the conversation.
      if (Math.abs(next.cx - view.current.cx) < 1e-6 && Math.abs(next.cy - view.current.cy) < 1e-6) return;
      event.preventDefault();
      show(next, box);
    };

    // iOS sends these with its touches (the touch pinch zooms); desktop Safari only these.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      safari = gesture === null ? { start: view.current, scale: (event as GestureEvent).scale || 1 } : null;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const box = latest.current.measure();
      if (safari === null || gesture !== null || box === null) return;
      const { scale, clientX, clientY } = event as GestureEvent;
      show(zoomAround(safari.start, scale / safari.scale, local(box, { x: clientX, y: clientY }), box.pane, box.content), box);
    };

    const touch = { passive: false } as const;
    for (const [name, value] of Object.entries(NO_BB_SWIPE)) surface.setAttribute(name, value);
    surface.addEventListener("touchstart", onTouchStart, touch);
    surface.addEventListener("touchmove", onTouchMove, touch);
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchEnd);
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerEnd);
    surface.addEventListener("pointercancel", onPointerEnd);
    surface.addEventListener("click", onClick, true);
    surface.addEventListener("dblclick", onDoubleClick);
    surface.addEventListener("wheel", onWheel, touch);
    surface.addEventListener("gesturestart", onGestureStart, touch);
    surface.addEventListener("gesturechange", onGestureChange, touch);
    return () => {
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", onTouchEnd);
      surface.removeEventListener("touchcancel", onTouchEnd);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerEnd);
      surface.removeEventListener("pointercancel", onPointerEnd);
      surface.removeEventListener("click", onClick, true);
      surface.removeEventListener("dblclick", onDoubleClick);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("gesturestart", onGestureStart);
      surface.removeEventListener("gesturechange", onGestureChange);
      for (const name of Object.keys(NO_BB_SWIPE)) surface.removeAttribute(name);
    };
  }, [surface, show]);

  return { zoomed, zoomBy, reset, redraw };
}

const ZOOM_STEP = 1.5;

export const VIEWER_BUTTON =
  "flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2";

/**
 * A zoomable pane filling the viewer: `children` drawn at `content`'s size
 * (its natural size; null until known) and fitted, then zoomed and panned.
 * Zoom buttons float at its foot. A tap on the pane around the content is
 * `onBackdropTap`.
 */
export function ZoomPane({
  content,
  onSwipe,
  onBackdropTap,
  tone,
  children,
}: {
  content: Size | null;
  onSwipe?: (dx: number, dy: number) => void;
  onBackdropTap: () => void;
  tone: ViewerTone;
  children: ReactNode;
}) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const media = useRef<HTMLDivElement>(null);
  const zoom = usePanZoom(pane, {
    measure: () => {
      if (pane === null || content === null) return null;
      const rect = pane.getBoundingClientRect();
      return { left: rect.left, top: rect.top, pane: { width: pane.clientWidth, height: pane.clientHeight }, content };
    },
    draw: (placed) => {
      if (media.current !== null) media.current.style.transform = `translate(${placed.x}px, ${placed.y}px) scale(${placed.scale})`;
    },
    plainWheel: true,
    doubleTap: true,
    onSwipe,
  });
  const { redraw } = zoom;

  useLayoutEffect(() => {
    redraw();
    if (pane === null) return;
    const observer = new ResizeObserver(redraw);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane, content, redraw]);

  const button = cn(VIEWER_BUTTON, "size-9", TONES[tone].button);
  return (
    <div
      ref={setPane}
      data-genui-viewer-pane=""
      onClick={(event) => {
        if (event.target === event.currentTarget) onBackdropTap();
      }}
      className={cn("relative min-h-0 flex-1 touch-none select-none overflow-hidden", zoom.zoomed && "cursor-grab active:cursor-grabbing")}
    >
      <div
        ref={media}
        data-genui-viewer-media=""
        className="absolute left-0 top-0 origin-top-left"
        style={content === null ? { visibility: "hidden" } : { width: content.width, height: content.height }}
      >
        {children}
      </div>
      <div
        role="group"
        aria-label="Zoom"
        className={cn("absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full p-1 backdrop-blur-md", TONES[tone].bar)}
      >
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={!zoom.zoomed} onClick={() => zoom.zoomBy(1 / ZOOM_STEP)} className={cn(button, "disabled:opacity-40")}>
          <Icon name="ZoomOut" aria-hidden className="size-4" />
        </button>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoom.zoomBy(ZOOM_STEP)} className={button}>
          <Icon name="ZoomIn" aria-hidden className="size-4" />
        </button>
        <button type="button" aria-label="Reset zoom" title="Fit (0)" disabled={!zoom.zoomed} onClick={zoom.reset} className={cn(button, "disabled:opacity-40")}>
          <Icon name="RotateCcw" aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}

export type ViewerTone = "photo" | "page";

/** Photos on near-black; drawings (diagrams) on the page's own background, whose colours they were drawn in. */
const TONES: Record<ViewerTone, { readonly shell: string; readonly button: string; readonly bar: string; readonly muted: string }> = {
  photo: {
    shell: "bg-black/95 text-white backdrop-blur-md",
    button: "bg-white/10 text-white hover:bg-white/20 focus-visible:ring-white/70",
    bar: "bg-black/40",
    muted: "text-white/70",
  },
  page: {
    shell: "bg-background text-foreground",
    button: "bg-surface-recessed text-foreground hover:bg-state-hover focus-visible:ring-ring",
    bar: "bg-surface-scrim/90 shadow-[0_1px_4px_rgb(0_0_0/0.15)]",
    muted: "text-muted-foreground",
  },
};

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The full-screen shell: a top bar (`status`, `actions`, close), the pane and
 * an optional footer. Closed by Escape, the close button or a tap on the
 * shell itself; focus stays inside while open and the page under it doesn't
 * scroll. With threads side by side (or stacked) in BB it covers the pane the
 * block is in, and the rest of the window dims and closes it on a tap.
 * Portaled to the body with the plugin's scope attributes so its styles
 * still apply. `onKeyDown` sees keys first and takes one by preventing its
 * default.
 */
export function FullScreen({
  label,
  tone,
  status,
  actions,
  footer,
  onKeyDown,
  onClose,
  children,
}: {
  label: string;
  tone: ViewerTone;
  status?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  onKeyDown?: (event: KeyboardEvent) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const pluginId = experimental_usePluginId();
  const motion = useMotionScope();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Stays where the view was opened from, so the view finds the pane around it.
  const anchor = useRef<HTMLSpanElement>(null);
  const bounds = usePaneBounds(anchor, true);

  useLayoutEffect(() => {
    close.current?.focus();
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    if (!reducedMotion()) {
      dialog.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: EASE_OUT_EXPO });
    }
    // A dialog the viewer was opened from hands focus back to its trigger as it closes; keep it here.
    const keep = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) close.current?.focus();
    };
    document.addEventListener("focusin", keep);
    return () => {
      document.removeEventListener("focusin", keep);
      root.style.overflow = overflow;
    };
  }, []);

  const keyDown = (event: KeyboardEvent) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex='0']") ?? [])];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const portal = createPortal(
    // pointer-events: a modal Radix dialog (Entity's detail) leaves the body unclickable until its exit ends.
    // React bubbles a portal's events through the component that opened it: a
    // click or key in here must not toggle a row, close a panel or pick a pin there.
    <div
      {...motion}
      data-bb-plugin={pluginId}
      data-bb-plugin-root=""
      data-bb-portaled-overlay=""
      data-bb-image-preview-ignore=""
      style={{ pointerEvents: "auto" }}
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onMouseDown={stop}
    >
      {bounds === null ? null : <div aria-hidden className="fixed inset-0 z-[2147483000] bg-black/40" onClick={onClose} />}
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-genui-viewer=""
        // Focusable, so a press on the picture keeps focus (and Escape, arrows) in here.
        tabIndex={-1}
        onKeyDown={keyDown}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        className={cn("fixed inset-0 z-[2147483000] flex select-none flex-col overscroll-none outline-none", TONES[tone].shell)}
        style={bounds === null ? undefined : { ...bounds, right: "auto", bottom: "auto" }}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <span className={cn("min-w-0 truncate text-xs tabular-nums", TONES[tone].muted)}>{status}</span>
          <span className="flex shrink-0 items-center gap-2">
            {actions}
            <button ref={close} type="button" aria-label="Close" title="Close (Esc)" onClick={onClose} className={cn(VIEWER_BUTTON, TONES[tone].button)}>
              <Icon name="X" className="size-5" />
            </button>
          </span>
        </div>
        {children}
        {footer}
      </div>
    </div>,
    document.body,
  );
  return (
    <>
      <span ref={anchor} hidden />
      {portal}
    </>
  );
}

/** Horizontal travel that turns a swipe into the next or previous picture. */
const SWIPE_PX = 48;

/**
 * Pictures full screen: the picture fitted, zoomed and panned, its caption
 * (or alt) and credit under it, previous and next by buttons, arrow keys or
 * a swipe while fitted; a swipe down or a tap beside the picture closes it.
 */
export function ImageViewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: readonly Viewable[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[Math.min(index, items.length - 1)]!;
  const many = items.length > 1;
  const step = (by: number) => onIndex((index + by + items.length) % items.length);
  const [natural, setNatural] = useState<{ readonly url: string; readonly size: Size } | null>(null);
  const { openFile } = useUiRuntime();
  const path = item.path;
  const size = natural?.url === item.url ? natural.size : null;
  const text = item.caption ?? (item.alt || null);
  const button = cn(VIEWER_BUTTON, TONES.photo.button, "absolute top-1/2 z-10 -translate-y-1/2 max-sm:hidden");

  return (
    <FullScreen
      label={text ?? "Picture"}
      tone="photo"
      status={many ? `${index + 1} / ${items.length}` : null}
      actions={
        path === undefined || openFile === null ? null : (
          <button
            type="button"
            aria-label={`Open ${path}`}
            title={`Open ${path}`}
            onClick={async () => {
              if (await openFile(path)) onClose();
              else toast.error(`Couldn't open ${path}`);
            }}
            className={cn(VIEWER_BUTTON, TONES.photo.button)}
          >
            <Icon name="FileText" className="size-5" />
          </button>
        )
      }
      onClose={onClose}
      onKeyDown={(event) => {
        if (many && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
          event.preventDefault();
          step(event.key === "ArrowRight" ? 1 : -1);
        }
      }}
      footer={
        text === null && item.credit === undefined ? null : (
          <div className="mx-auto flex w-full max-w-2xl shrink-0 flex-col gap-1 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 text-center">
            {text === null ? null : <p className="m-0 select-text text-sm leading-5 text-white/90">{text}</p>}
            {item.credit}
          </div>
        )
      }
    >
      <div className="relative flex min-h-0 flex-1">
        <ZoomPane
          key={item.url}
          content={size}
          tone="photo"
          onBackdropTap={onClose}
          onSwipe={(dx, dy) => {
            if (many && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
            else if (dy > SWIPE_PX * 2 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose();
          }}
        >
          <img
            src={item.url}
            alt={item.alt}
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              // An SVG without width/height has no size of its own: draw it as large as the screen.
              const fallback = { width: innerWidth, height: innerHeight };
              setNatural({ url: item.url, size: naturalWidth > 0 && naturalHeight > 0 ? { width: naturalWidth, height: naturalHeight } : fallback });
            }}
            className="block size-full max-w-none rounded-sm"
          />
        </ZoomPane>
        {many ? (
          <>
            <button type="button" aria-label="Previous picture" onClick={() => step(-1)} className={cn(button, "left-3")}>
              <Icon name="ChevronLeft" className="size-5" />
            </button>
            <button type="button" aria-label="Next picture" onClick={() => step(1)} className={cn(button, "right-3")}>
              <Icon name="ChevronRight" className="size-5" />
            </button>
          </>
        ) : null}
      </div>
    </FullScreen>
  );
}

/**
 * A component's pictures in the viewer. `open(index, opener)` shows one;
 * closing gives focus back to the opener, then calls `onClose`. The picture
 * shown is kept by URL, so pictures that finish loading meanwhile don't
 * move it.
 */
export function useViewer(items: readonly Viewable[], onClose?: () => void): { readonly open: (index: number, opener: HTMLElement | null) => void; readonly viewer: ReactNode } {
  const [shown, setShown] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const index = shown === null ? -1 : items.findIndex((item) => item.url === shown);
  return {
    open: (at, from) => {
      opener.current = from;
      setShown(items[at]?.url ?? null);
    },
    viewer:
      index === -1 ? null : (
        <ImageViewer
          items={items}
          index={index}
          onIndex={(next) => setShown(items[next]!.url)}
          onClose={() => {
            // Gone first: while it is open, the viewer keeps focus inside itself.
            flushSync(() => setShown(null));
            opener.current?.focus();
            onClose?.();
          }}
        />
      ),
  };
}

interface Group {
  readonly show: (order: number, picture: Viewable | null) => void;
  readonly open: (url: string, opener: HTMLElement) => void;
}

const GroupContext = createContext<Group | null>(null);

/**
 * One component's pictures that separate children load (evidence images, an
 * option's picture), viewed together: each registers with
 * `useGroupPicture`, and the viewer steps through them in their `order`.
 */
export function ViewerGroup({ children }: { children: ReactNode }) {
  const [pictures, setPictures] = useState<ReadonlyMap<number, Viewable>>(() => new Map());
  const items = [...pictures].sort(([a], [b]) => a - b).map(([, picture]) => picture);
  const { open, viewer } = useViewer(items);
  const latest = useRef({ items, open });
  latest.current = { items, open };
  const group = useMemo<Group>(
    () => ({
      show: (order, picture) =>
        setPictures((previous) => {
          const before = previous.get(order);
          if (picture === null ? before === undefined : before?.url === picture.url && before.alt === picture.alt && before.caption === picture.caption) {
            return previous;
          }
          const next = new Map(previous);
          if (picture === null) next.delete(order);
          else next.set(order, picture);
          return next;
        }),
      open: (url, opener) => latest.current.open(latest.current.items.findIndex((item) => item.url === url), opener),
    }),
    [],
  );
  return (
    <GroupContext value={group}>
      {children}
      {viewer}
    </GroupContext>
  );
}

/** Registers a picture (null while it can't be shown) with the ViewerGroup around it; returns what opens it there. */
export function useGroupPicture(order: number, picture: Viewable | null): (opener: HTMLElement) => void {
  const group = useContext(GroupContext);
  if (group === null) throw new Error("useGroupPicture needs a ViewerGroup around it");
  const { url, alt, caption } = picture ?? {};
  useEffect(() => {
    group.show(order, url === undefined ? null : { url, alt: alt ?? "", caption: caption ?? null });
    return () => group.show(order, null);
  }, [group, order, url, alt, caption]);
  return (opener) => {
    if (url !== undefined) group.open(url, opener);
  };
}

/** The open affordance on a picture that already does something when pressed (pins, a selection): an expand button at its corner. */
export function ExpandButton({ label, onOpen, className }: { label: string; onOpen: (opener: HTMLButtonElement) => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}
      className={cn(
        "absolute z-10 flex size-7 cursor-zoom-in items-center justify-center rounded-full bg-black/55 text-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] backdrop-blur-sm transition-colors duration-150 hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-8",
        className,
      )}
    >
      <Icon name="Maximize2" aria-hidden className="size-3.5" />
    </button>
  );
}
