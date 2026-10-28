import { describe, expect, it } from "vitest";
import {
  clampView,
  DOUBLE_TAP_ZOOM,
  FIT_VIEW,
  fitScale,
  MAX_ZOOM,
  panBy,
  pinchView,
  placeImage,
  toggleZoom,
  wheelZoomFactor,
  zoomAround,
  type Point,
  type View,
} from "./zoomMath";

const pane = { width: 400, height: 250 };
const image = { width: 1600, height: 1000 };

/** The image point (image pixels) shown at pane point `at` under `view`. */
function imagePointAt(view: View, at: Point): Point {
  const placed = placeImage(view, pane, image);
  return { x: (at.x - placed.x) / placed.scale, y: (at.y - placed.y) / placed.scale };
}

describe("view geometry", () => {
  it("fits by containing, and never blows a small image up", () => {
    expect(fitScale(pane, image)).toBe(0.25);
    expect(fitScale(pane, { width: 200, height: 100 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, image)).toBe(1);
  });

  it("centres the fitted image and clamps a zoomed one to its edges", () => {
    expect(placeImage(FIT_VIEW, { width: 400, height: 400 }, image)).toEqual({ scale: 0.25, x: 0, y: 75 });
    expect(placeImage({ zoom: 4, cx: 0, cy: 0 }, pane, image)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(placeImage({ zoom: 4, cx: 1, cy: 1 }, pane, image)).toEqual({ scale: 1, x: -1200, y: -750 });
  });

  it("keeps the point under the cursor in place while zooming", () => {
    const at = { x: 100, y: 60 };
    const view = zoomAround(FIT_VIEW, 3, at, pane, image);
    expect(view.zoom).toBe(3);
    expect(imagePointAt(view, at).x).toBeCloseTo(imagePointAt(FIT_VIEW, at).x, 6);
    expect(imagePointAt(view, at).y).toBeCloseTo(imagePointAt(FIT_VIEW, at).y, 6);
  });

  it("clamps zoom to 1…MAX_ZOOM and pans only as far as the edges", () => {
    expect(zoomAround(FIT_VIEW, 0.5, { x: 0, y: 0 }, pane, image)).toEqual(FIT_VIEW);
    expect(zoomAround(FIT_VIEW, 1000, { x: 200, y: 125 }, pane, image).zoom).toBe(MAX_ZOOM);
    expect(panBy(FIT_VIEW, 50, 50, pane, image)).toEqual(FIT_VIEW);
    const zoomed = { zoom: 2, cx: 0.5, cy: 0.5 };
    expect(panBy(zoomed, 100, 0, pane, image)).toEqual({ zoom: 2, cx: 0.375, cy: 0.5 });
    expect(panBy(zoomed, 10_000, 0, pane, image).cx).toBeCloseTo(0.25, 9);
    expect(clampView({ zoom: Number.NaN, cx: 9, cy: -9 }, pane, image)).toEqual(FIT_VIEW);
  });

  it("lets a zoomed picture that is still smaller than the pane be dragged, inside the pane", () => {
    // A small diagram in a large full-screen pane: fitted at 1:1, zoomed 2× it still fits.
    const big = { width: 1300, height: 900 };
    const small = { width: 600, height: 300 };
    const zoomed = { zoom: 2, cx: 0.5, cy: 0.5 };
    expect(placeImage(zoomed, big, small)).toEqual({ scale: 2, x: 50, y: 150 });
    const moved = panBy(zoomed, -30, 40, big, small);
    expect(placeImage(moved, big, small)).toEqual({ scale: 2, x: 20, y: 190 });
    // It stops at the pane's edges.
    expect(placeImage(panBy(zoomed, 10_000, -10_000, big, small), big, small)).toEqual({ scale: 2, x: 100, y: 0 });
    // A wide diagram on a tall phone pane: the short axis moves too, and zooming back to fit recentres it.
    const phone = { width: 390, height: 760 };
    const wide = { width: 900, height: 300 };
    const view = panBy({ zoom: 2, cx: 0.5, cy: 0.5 }, 0, -60, phone, wide);
    expect(placeImage(view, phone, wide).y).toBeCloseTo(380 - 130 - 60, 6);
    expect(placeImage({ ...view, zoom: 1 }, phone, wide).y).toBeCloseTo((760 - 130) / 2, 6);
  });
});

describe("pinchView", () => {
  it("scales by how far the fingers spread, keeping the point between them under them", () => {
    const from = [{ x: 180, y: 120 }, { x: 220, y: 120 }] as const;
    const to = [{ x: 120, y: 120 }, { x: 280, y: 120 }] as const;
    const view = pinchView(FIT_VIEW, from, to, pane, image);
    expect(view.zoom).toBeCloseTo(4, 9);
    expect(imagePointAt(view, { x: 200, y: 120 }).x).toBeCloseTo(imagePointAt(FIT_VIEW, { x: 200, y: 120 }).x, 6);
  });

  it("pans with the midpoint when the fingers move together", () => {
    const start = { zoom: 3, cx: 0.5, cy: 0.5 };
    const from = [{ x: 150, y: 100 }, { x: 250, y: 100 }] as const;
    const to = [{ x: 110, y: 130 }, { x: 210, y: 130 }] as const;
    const view = pinchView(start, from, to, pane, image);
    expect(view.zoom).toBeCloseTo(3, 9);
    expect(imagePointAt(view, { x: 160, y: 130 }).x).toBeCloseTo(imagePointAt(start, { x: 200, y: 100 }).x, 6);
    expect(imagePointAt(view, { x: 160, y: 130 }).y).toBeCloseTo(imagePointAt(start, { x: 200, y: 100 }).y, 6);
  });

  it("pinching in past the fitted size stays fitted, and two fingers on one spot change nothing", () => {
    const from = [{ x: 100, y: 100 }, { x: 300, y: 100 }] as const;
    const to = [{ x: 190, y: 100 }, { x: 210, y: 100 }] as const;
    expect(pinchView(FIT_VIEW, from, to, pane, image)).toEqual(FIT_VIEW);
    const same = [{ x: 50, y: 50 }, { x: 50, y: 50 }] as const;
    expect(pinchView(FIT_VIEW, same, same, pane, image)).toEqual(FIT_VIEW);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on an upward scroll and out on a downward one, a notch at most one step", () => {
    expect(wheelZoomFactor(-100, 0, 500)).toBeCloseTo(Math.exp(0.5), 9);
    expect(wheelZoomFactor(100, 0, 500)).toBeCloseTo(Math.exp(-0.5), 9);
    expect(wheelZoomFactor(-3, 1, 500)).toBeCloseTo(Math.exp(0.48), 9);
    expect(wheelZoomFactor(-1, 2, 500)).toBeCloseTo(Math.exp(0.5), 9);
    expect(wheelZoomFactor(0, 0, 500)).toBe(1);
  });
});

describe("toggleZoom", () => {
  it("zooms in at the tapped point from the fitted size and back to fit from any zoom", () => {
    const at = { x: 300, y: 80 };
    const view = toggleZoom(FIT_VIEW, at, pane, image);
    expect(view.zoom).toBe(DOUBLE_TAP_ZOOM);
    expect(imagePointAt(view, at).x).toBeCloseTo(imagePointAt(FIT_VIEW, at).x, 6);
    expect(toggleZoom(view, at, pane, image)).toEqual(FIT_VIEW);
  });
});
