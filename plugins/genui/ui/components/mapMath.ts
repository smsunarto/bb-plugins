// Web Mercator math for Map: places to world coordinates, the view that fits
// them, panning and zooming about a point, the OpenStreetMap tiles a view
// needs, and the pace of a tour. World coordinates run 0..1 across and down;
// a view is the world point at the viewport's centre and a fractional zoom.

export const TILE_SIZE = 256;
export const MIN_ZOOM = 1;
/** OSM serves z19, but z18 is already street level and keeps tile counts sane. */
export const MAX_ZOOM = 18;
/** Mercator's square world ends here. */
const MAX_LATITUDE = 85.05112878;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface View extends Point {
  readonly zoom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Tile {
  /** Tile coordinates to fetch (x wrapped around the world). */
  readonly z: number;
  readonly x: number;
  readonly y: number;
  /** Unique per drawn copy, since a wide view can show the same tile twice. */
  readonly key: string;
  readonly left: number;
  readonly top: number;
  readonly size: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The world's width in pixels at `zoom`. */
function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

/** Latitude and longitude in degrees to world coordinates. */
export function project(lat: number, lng: number): Point {
  const sin = Math.sin((clamp(lat, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}

/** Keeps zoom in range and, where the world is taller than the viewport, the view inside it vertically. */
export function clampView(view: View, size: Size): View {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const half = size.height / 2 / worldSize(zoom);
  const y = half >= 0.5 ? 0.5 : clamp(view.y, half, 1 - half);
  // Longitude wraps; keep x in 0..1 so numbers stay small.
  return { x: view.x - Math.floor(view.x), y, zoom };
}

/** The view showing every point with `padding` pixels to spare, zoomed in no further than `maxZoom`. */
export function fitView(points: readonly Point[], size: Size, padding: number, maxZoom: number): View {
  if (points.length === 0) return clampView({ x: 0.5, y: 0.5, zoom: MIN_ZOOM }, size);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const width = Math.max(1, size.width - 2 * padding);
  const height = Math.max(1, size.height - 2 * padding);
  const zoomFor = (span: number, pixels: number) => (span === 0 ? maxZoom : Math.log2(pixels / (span * TILE_SIZE)));
  const zoom = Math.min(maxZoom, zoomFor(maxX - minX, width), zoomFor(maxY - minY, height));
  return clampView({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom }, size);
}

/** Where `point` sits in the viewport, using its copy of the world nearest the view's centre. */
export function toScreen(point: Point, view: View, size: Size): { readonly left: number; readonly top: number } {
  const scale = worldSize(view.zoom);
  const dx = point.x - view.x;
  return {
    left: (dx - Math.round(dx)) * scale + size.width / 2,
    top: (point.y - view.y) * scale + size.height / 2,
  };
}

/** The view moved by a drag of `dx`, `dy` pixels. */
export function pan(view: View, dx: number, dy: number, size: Size): View {
  const scale = worldSize(view.zoom);
  return clampView({ x: view.x - dx / scale, y: view.y - dy / scale, zoom: view.zoom }, size);
}

/** The view at `zoom`, with the world point under `anchor` (viewport pixels) still under it. */
export function zoomAround(view: View, zoom: number, anchor: { left: number; top: number }, size: Size): View {
  const target = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const offsetX = anchor.left - size.width / 2;
  const offsetY = anchor.top - size.height / 2;
  const before = worldSize(view.zoom);
  const after = worldSize(target);
  const x = view.x + offsetX / before - offsetX / after;
  const y = view.y + offsetY / before - offsetY / after;
  return clampView({ x, y, zoom: target }, size);
}

/** The tile zoom level drawn for a view: the nearest whole level. */
export function tileZoom(view: View): number {
  return clamp(Math.round(view.zoom), 0, MAX_ZOOM);
}

/** The tiles at level `z` (default: the view's) covering the viewport, each with its place and drawn size. */
export function visibleTiles(view: View, size: Size, z = tileZoom(view)): Tile[] {
  const count = 2 ** z;
  const scale = worldSize(view.zoom);
  const tileSize = scale / count;
  const left = view.x - size.width / 2 / scale;
  const right = view.x + size.width / 2 / scale;
  const top = view.y - size.height / 2 / scale;
  const bottom = view.y + size.height / 2 / scale;
  const tiles: Tile[] = [];
  for (let ty = Math.max(0, Math.floor(top * count)); ty <= Math.min(count - 1, Math.floor(bottom * count)); ty += 1) {
    for (let tx = Math.floor(left * count); tx <= Math.floor(right * count); tx += 1) {
      tiles.push({
        z,
        x: ((tx % count) + count) % count,
        y: ty,
        key: `${z}/${tx}/${ty}`,
        left: (tx / count - view.x) * scale + size.width / 2,
        top: (ty / count - view.y) * scale + size.height / 2,
        size: tileSize,
      });
    }
  }
  return tiles;
}

/** A tour drops every pin in about this long, however many places there are (within the step limits). */
export const TOUR_MS = 6000;
/** Fewer places don't crawl, many don't flicker past. */
const TOUR_STEP_MIN_MS = 300;
const TOUR_STEP_MAX_MS = 1500;

/** The time between two pins of a tour of `count` places: the first drops at once, the last about TOUR_MS later. */
export function tourStep(count: number): number {
  return clamp(TOUR_MS / Math.max(1, count - 1), TOUR_STEP_MIN_MS, TOUR_STEP_MAX_MS);
}
