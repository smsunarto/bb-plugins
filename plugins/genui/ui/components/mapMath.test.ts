import { describe, expect, it } from "vitest";
import { clampView, fitView, MAX_ZOOM, MIN_ZOOM, pan, project, toScreen, TOUR_MS, tourStep, visibleTiles, zoomAround } from "./mapMath";

const size = { width: 600, height: 400 };
const lisbon = project(38.7223, -9.1393);
const sintra = project(38.8029, -9.3817);
const cascais = project(38.6979, -9.4215);

describe("project", () => {
  it("maps the equator and meridian to the world's centre and the antimeridian to its edge", () => {
    expect(project(0, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(project(0, 180).x).toBe(1);
    expect(project(0, -180).x).toBe(0);
  });

  it("puts north up and clamps the poles to Mercator's square", () => {
    expect(project(60, 0).y).toBeLessThan(0.5);
    expect(project(90, 0).y).toBeCloseTo(0, 6);
    expect(project(-90, 0).y).toBeCloseTo(1, 6);
  });
});

describe("fitView", () => {
  it("shows every place inside the padding", () => {
    const view = fitView([lisbon, sintra, cascais], size, 40, 15);
    for (const point of [lisbon, sintra, cascais]) {
      const { left, top } = toScreen(point, view, size);
      expect(left).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(left).toBeLessThanOrEqual(size.width - 40 + 1e-6);
      expect(top).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(top).toBeLessThanOrEqual(size.height - 40 + 1e-6);
    }
    // Tight: zooming in one more level would push a place out.
    const closer = { ...view, zoom: view.zoom + 1 };
    const outside = [lisbon, sintra, cascais].some((point) => {
      const { left, top } = toScreen(point, closer, size);
      return left < 40 || left > size.width - 40 || top < 40 || top > size.height - 40;
    });
    expect(outside).toBe(true);
  });

  it("centres a single place at the zoom cap, and an empty map on the whole world", () => {
    const one = fitView([lisbon], size, 40, 14);
    expect(one.zoom).toBe(14);
    expect(toScreen(lisbon, one, size)).toEqual({ left: 300, top: 200 });
    expect(fitView([], size, 40, 14).zoom).toBe(MIN_ZOOM);
  });
});

describe("zoomAround and pan", () => {
  it("keeps the world point under the anchor fixed while zooming", () => {
    const view = fitView([lisbon, sintra], size, 40, 15);
    const anchor = toScreen(sintra, view, size);
    const zoomed = zoomAround(view, view.zoom + 1.5, anchor, size);
    const after = toScreen(sintra, zoomed, size);
    expect(after.left).toBeCloseTo(anchor.left, 6);
    expect(after.top).toBeCloseTo(anchor.top, 6);
  });

  it("moves the map with the drag and clamps zoom", () => {
    const view = fitView([lisbon], size, 40, 12);
    const before = toScreen(lisbon, view, size);
    const after = toScreen(lisbon, pan(view, 30, -20, size), size);
    expect(after.left - before.left).toBeCloseTo(30, 6);
    expect(after.top - before.top).toBeCloseTo(-20, 6);
    expect(zoomAround(view, 40, { left: 0, top: 0 }, size).zoom).toBe(MAX_ZOOM);
  });

  it("keeps a zoomed-out world filling the height and wraps longitude", () => {
    // At zoom 1 the world is 512 px tall: shorter than a 600 px viewport, so it sits centred.
    expect(clampView({ x: 1.25, y: 0.9, zoom: 1 }, { width: 600, height: 600 })).toEqual({ x: 0.25, y: 0.5, zoom: 1 });
    expect(clampView({ x: 0.5, y: 0.999, zoom: 5 }, size).y).toBeCloseTo(1 - 200 / (256 * 32), 9);
  });
});

describe("visibleTiles", () => {
  it("covers the viewport edge to edge with tiles of the nearest level", () => {
    const view = { ...fitView([lisbon, sintra, cascais], size, 40, 15), zoom: 10.3 };
    const tiles = visibleTiles(view, size);
    expect(new Set(tiles.map((tile) => tile.z))).toEqual(new Set([10]));
    expect(Math.min(...tiles.map((tile) => tile.left))).toBeLessThanOrEqual(0);
    expect(Math.min(...tiles.map((tile) => tile.top))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((tile) => tile.left + tile.size))).toBeGreaterThanOrEqual(size.width);
    expect(Math.max(...tiles.map((tile) => tile.top + tile.size))).toBeGreaterThanOrEqual(size.height);
    expect(tiles[0].size).toBeCloseTo(256 * 2 ** 0.3, 6);
  });

  it("wraps x across the antimeridian and never asks for rows outside the world", () => {
    const tiles = visibleTiles({ x: 0.001, y: 0.5, zoom: 2 }, { width: 600, height: 2000 });
    expect(tiles.every((tile) => tile.x >= 0 && tile.x < 4 && tile.y >= 0 && tile.y < 4)).toBe(true);
    expect(tiles.some((tile) => tile.x === 3)).toBe(true);
    expect(new Set(tiles.map((tile) => tile.key)).size).toBe(tiles.length);
  });
});

describe("tourStep", () => {
  it("drops the last pin about TOUR_MS after the first for a typical trip", () => {
    for (const count of [5, 8, 13]) expect((count - 1) * tourStep(count)).toBeCloseTo(TOUR_MS, 0);
  });

  it("neither crawls for a couple of places nor flickers through many", () => {
    expect(tourStep(1)).toBe(1500);
    expect(tourStep(2)).toBe(1500);
    expect(tourStep(60)).toBe(300);
  });
});
