// Compare's pixel work, kept free of the DOM so it can be tested: which
// pixels differ beyond a tolerance, the boxes around changed regions, and the
// view that frames one (the zoom and pan itself is zoomMath.ts).
import type { Size } from "../../core/compare";
import { clampView, fitScale, type View } from "./zoomMath";

/** Per-channel tolerance (0-255) a fresh Compare starts with: anti-aliasing and JPEG noise stay quiet, a recoloured or moved element does not. */
export const DEFAULT_TOLERANCE = 8;
export const MAX_TOLERANCE = 64;

export interface PixelDiff {
  /** 1 where the pixel differs beyond the tolerance, row-major. */
  readonly mask: Uint8Array;
  readonly changed: number;
  readonly total: number;
}

/**
 * Compares two RGBA buffers of the same `width`×`height`. A pixel changed
 * when any premultiplied channel (or alpha) differs by more than `tolerance`
 * of 255, so two fully transparent pixels match whatever colour they carry.
 */
export function pixelDiff(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  tolerance: number,
): PixelDiff {
  const total = Math.max(0, width * height);
  const mask = new Uint8Array(total);
  let changed = 0;
  for (let pixel = 0, offset = 0; pixel < total; pixel++, offset += 4) {
    const alphaA = a[offset + 3] ?? 0;
    const alphaB = b[offset + 3] ?? 0;
    let delta = Math.abs(alphaA - alphaB);
    if (delta <= tolerance) {
      for (let channel = 0; channel < 3 && delta <= tolerance; channel++) {
        const d = Math.abs(((a[offset + channel] ?? 0) * alphaA - (b[offset + channel] ?? 0) * alphaB) / 255);
        if (d > delta) delta = d;
      }
    }
    if (delta > tolerance) {
      mask[pixel] = 1;
      changed++;
    }
  }
  return { mask, changed, total };
}

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Changed pixels inside. */
  readonly pixels: number;
}

/**
 * Boxes around the changed pixels of `mask`: pixels are binned into `cell`-px
 * cells, touching cells and cells with up to `gap` empty cells between them join one region (so a changed
 * word is one box, not one per letter), each box is fitted tightly to its
 * pixels, and boxes that overlap merge. Largest first; past `max`, `more`
 * counts the regions left out.
 */
export function changedRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  { cell = 8, gap = 2, max = 40 }: { cell?: number; gap?: number; max?: number } = {},
): { regions: Region[]; more: number } {
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cells = columns * rows;
  if (cells === 0) return { regions: [], more: 0 };
  // Per cell: changed count and the tight bounds of its changed pixels.
  const count = new Uint32Array(cells);
  const bounds = new Int32Array(cells * 4);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const cellRow = Math.floor(y / cell) * columns;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 1) continue;
      const index = cellRow + Math.floor(x / cell);
      const at = index * 4;
      if (count[index] === 0) {
        bounds[at] = x;
        bounds[at + 1] = y;
        bounds[at + 2] = x;
        bounds[at + 3] = y;
      } else {
        if (x < bounds[at]!) bounds[at] = x;
        if (x > bounds[at + 2]!) bounds[at + 2] = x;
        bounds[at + 3] = y;
      }
      count[index]!++;
    }
  }

  let boxes: { x0: number; y0: number; x1: number; y1: number; pixels: number }[] = [];
  const seen = new Uint8Array(cells);
  const queue: number[] = [];
  for (let start = 0; start < cells; start++) {
    if (count[start] === 0 || seen[start] === 1) continue;
    seen[start] = 1;
    queue.length = 0;
    queue.push(start);
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, pixels: 0 };
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head]!;
      const at = index * 4;
      box.x0 = Math.min(box.x0, bounds[at]!);
      box.y0 = Math.min(box.y0, bounds[at + 1]!);
      box.x1 = Math.max(box.x1, bounds[at + 2]!);
      box.y1 = Math.max(box.y1, bounds[at + 3]!);
      box.pixels += count[index]!;
      const cx = index % columns;
      const cy = (index - cx) / columns;
      // Neighbours touch at distance 1; `gap` empty cells may sit between two that still join.
      const reach = gap + 1;
      for (let ny = Math.max(0, cy - reach); ny <= Math.min(rows - 1, cy + reach); ny++) {
        for (let nx = Math.max(0, cx - reach); nx <= Math.min(columns - 1, cx + reach); nx++) {
          const next = ny * columns + nx;
          if (count[next] === 0 || seen[next] === 1) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    boxes.push(box);
  }

  // Tight boxes of neighbouring components can still overlap: merge until none do.
  for (let merged = true; merged; ) {
    merged = false;
    const next: typeof boxes = [];
    for (const box of boxes) {
      const hit = next.find((other) => box.x0 <= other.x1 && other.x0 <= box.x1 && box.y0 <= other.y1 && other.y0 <= box.y1);
      if (hit === undefined) {
        next.push({ ...box });
        continue;
      }
      hit.x0 = Math.min(hit.x0, box.x0);
      hit.y0 = Math.min(hit.y0, box.y0);
      hit.x1 = Math.max(hit.x1, box.x1);
      hit.y1 = Math.max(hit.y1, box.y1);
      hit.pixels += box.pixels;
      merged = true;
    }
    boxes = next;
  }

  boxes.sort((a, b) => b.pixels - a.pixels || a.y0 - b.y0 || a.x0 - b.x0);
  return {
    regions: boxes.slice(0, max).map((box) => ({ x: box.x0, y: box.y0, width: box.x1 - box.x0 + 1, height: box.y1 - box.y0 + 1, pixels: box.pixels })),
    more: Math.max(0, boxes.length - max),
  };
}

/** A share of pixels as people read it: whole from 10%, one decimal from 1%, two significant digits below; never "0%" for a change. */
export function formatPixelShare(changed: number, total: number): string {
  if (!(total > 0) || changed <= 0) return "0%";
  const percent = (changed / total) * 100;
  if (percent >= 10) return `${Math.round(percent)}%`;
  if (percent >= 1) return `${Number(percent.toFixed(1))}%`;
  return `${Number(percent.toPrecision(2))}%`;
}

// ---------------------------------------------------------------------------
// The view of a changed region

/**
 * The view that shows `region` (image pixels) as large as it fits with a
 * margin of half its size around it, and never less than 96×64 image pixels,
 * so a changed letter keeps the words around it.
 */
export function viewOfRegion(region: Region, pane: Size, image: Size): View {
  const fit = fitScale(pane, image);
  const width = Math.max(region.width * 2, 96);
  const height = Math.max(region.height * 2, 64);
  const zoom = Math.min(pane.width / width, pane.height / height) / fit;
  return clampView(
    { zoom, cx: (region.x + region.width / 2) / image.width, cy: (region.y + region.height / 2) / image.height },
    pane,
    image,
  );
}

/** The largest pixel count the difference is computed at; a bigger reference is compared scaled down, and says so. */
export const MAX_DIFF_PIXELS = 8_000_000;

/** The grid the difference is computed on: the reference's own size, or scaled down to MAX_DIFF_PIXELS. */
export function diffGrid(reference: Size): Size & { readonly scale: number } {
  const pixels = reference.width * reference.height;
  const scale = pixels > MAX_DIFF_PIXELS ? Math.sqrt(MAX_DIFF_PIXELS / pixels) : 1;
  return { width: Math.max(1, Math.round(reference.width * scale)), height: Math.max(1, Math.round(reference.height * scale)), scale };
}
