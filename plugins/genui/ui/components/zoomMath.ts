// Zoom and pan of a picture in a pane, kept free of the DOM so it can be
// tested: Compare's shared view, the full-screen viewer and the inline
// diagram all draw from it.
import type { Size } from "../../core/compare";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A zoom and pan: `zoom` relative to fitting the image in its pane
 * (1 = fit), and the image point at the pane's centre as a fraction of the
 * image (0.5, 0.5 = centred). Fractions, not pixels, so panes of any size
 * show the same part of their image.
 */
export interface View {
  readonly zoom: number;
  readonly cx: number;
  readonly cy: number;
}

/** Where a view puts the image: its top-left corner in the pane and screen pixels per image pixel. */
export interface Placement {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const FIT_VIEW: View = { zoom: 1, cx: 0.5, cy: 0.5 };
export const MAX_ZOOM = 32;
/** How far a double tap zooms in from the fitted size. */
export const DOUBLE_TAP_ZOOM = 2.5;

/** Pixels on screen per image pixel when the image is contained in the pane; never above 1, so a small image is not blown up. */
export function fitScale(pane: Size, image: Size): number {
  if (!(image.width > 0 && image.height > 0 && pane.width > 0 && pane.height > 0)) return 1;
  return Math.min(1, pane.width / image.width, pane.height / image.height);
}

/**
 * Where the image's top-left corner sits in the pane and its scale, for
 * `view`. Along an axis where the image is larger than the pane it never
 * leaves a gap at an edge; where it is smaller it may sit anywhere inside the
 * pane (centred at `cx`/`cy` = 0.5, as when fitted). A wide diagram zoomed
 * on a tall phone screen, or a small one zoomed 2× on a large screen, is
 * still smaller than the pane in one or both axes, and a drag must move it.
 */
export function placeImage(view: View, pane: Size, image: Size): Placement {
  const scale = fitScale(pane, image) * view.zoom;
  const along = (paneLength: number, imageLength: number, centre: number) => {
    const shown = imageLength * scale;
    const wanted = paneLength / 2 - centre * shown;
    // Fitted (or zoomed back out to fit), a smaller image is centred again.
    if (shown <= paneLength) return view.zoom <= 1 ? (paneLength - shown) / 2 : Math.min(paneLength - shown, Math.max(0, wanted));
    return Math.min(0, Math.max(paneLength - shown, wanted));
  };
  return { scale, x: along(pane.width, image.width, view.cx), y: along(pane.height, image.height, view.cy) };
}

/** `view` with its zoom inside 1…MAX_ZOOM and its centre where `placeImage` would actually put it. */
export function clampView(view: View, pane: Size, image: Size): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(view.zoom) ? view.zoom : 1));
  const placed = placeImage({ zoom, cx: view.cx, cy: view.cy }, pane, image);
  const shownWidth = image.width * placed.scale;
  const shownHeight = image.height * placed.scale;
  return {
    zoom,
    cx: shownWidth > 0 ? (pane.width / 2 - placed.x) / shownWidth : 0.5,
    cy: shownHeight > 0 ? (pane.height / 2 - placed.y) / shownHeight : 0.5,
  };
}

/** Zooms by `factor` keeping the image point under `at` (pane coordinates) where it is. */
export function zoomAround(view: View, factor: number, at: Point, pane: Size, image: Size): View {
  const before = placeImage(view, pane, image);
  const imageX = (at.x - before.x) / before.scale;
  const imageY = (at.y - before.y) / before.scale;
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
  const scale = fitScale(pane, image) * zoom;
  const x = at.x - imageX * scale;
  const y = at.y - imageY * scale;
  return clampView(
    { zoom, cx: (pane.width / 2 - x) / (image.width * scale), cy: (pane.height / 2 - y) / (image.height * scale) },
    pane,
    image,
  );
}

/** Moves the image by `dx`, `dy` screen pixels (a drag), as far as its edges allow. */
export function panBy(view: View, dx: number, dy: number, pane: Size, image: Size): View {
  const scale = fitScale(pane, image) * view.zoom;
  if (!(scale > 0)) return view;
  return clampView({ zoom: view.zoom, cx: view.cx - dx / (image.width * scale), cy: view.cy - dy / (image.height * scale) }, pane, image);
}

/**
 * Two fingers that started at `from` on `start` and are now at `to`: the
 * image point under their midpoint follows it, scaled by how far they spread.
 */
export function pinchView(start: View, from: readonly [Point, Point], to: readonly [Point, Point], pane: Size, image: Size): View {
  const middle = (pair: readonly [Point, Point]) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const spread = (pair: readonly [Point, Point]) => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  const before = middle(from);
  const after = middle(to);
  const zoomed = zoomAround(start, spread(to) / (spread(from) || 1), before, pane, image);
  return panBy(zoomed, after.x - before.x, after.y - before.y, pane, image);
}

/**
 * The zoom factor of one wheel event. Trackpad pinches arrive as ctrl+wheel
 * with small deltas; a mouse wheel notch is clamped to one step.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, paneHeight: number): number {
  const lines = deltaMode === 1 ? 16 : deltaMode === 2 ? paneHeight : 1;
  return Math.exp(-Math.min(50, Math.max(-50, deltaY * lines)) * 0.01);
}

/** A double tap or double click: in to DOUBLE_TAP_ZOOM at the point from the fitted size, back to fit from any zoom. */
export function toggleZoom(view: View, at: Point, pane: Size, image: Size): View {
  return view.zoom > 1.01 ? FIT_VIEW : zoomAround(view, DOUBLE_TAP_ZOOM, at, pane, image);
}
