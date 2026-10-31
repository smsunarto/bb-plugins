// Gallery tile sizing, kept free of the DOM so it can be tested: how a tile
// is laid out, the box a single-column tile shows its picture in, and which
// pictures a uniform 4:3 thumbnail may crop.
import type { ImageSize } from "../runtime";

/** How a tile is laid out: a strip thumbnail, a cell of a multi-column grid, or the only column. */
export type TileLayout = "strip" | "grid" | "single";

/** The ratios a single-column tile's box stays within (wider or taller pictures letterbox). */
export const SINGLE_TALLEST = 1 / 2;
export const SINGLE_WIDEST = 4;
/** A single-column tile is at most this tall (rem), narrowing to keep its ratio, like Image's max-h-96. */
export const SINGLE_MAX_HEIGHT = 24;

/**
 * Ratios a 4:3 thumbnail crops to fill. A found photo crops from square to
 * 16:9, as photo grids do; a file or URL may be a screenshot, whose edges
 * matter, so only a picture close to 4:3 crops. Others are shown whole.
 */
export const PHOTO_CROPPABLE = [1, 16 / 9] as const;
export const PICTURE_CROPPABLE = [1.25, 1.42] as const;

/** A tile's layout: the only column when one is asked for, or when automatic layout has one picture. */
export function tileLayout(strip: boolean, columns: number): TileLayout {
  return strip ? "strip" : columns === 1 ? "single" : "grid";
}

/**
 * A single-column tile's frame at its picture's own ratio, so a screenshot
 * isn't cropped to 4:3 and blown up to the column's full width at 4:3 height.
 * Like Image, never wider than the picture itself.
 */
export function singleBox(size: ImageSize | null): {
  readonly aspectRatio: string;
  readonly maxWidth: string;
} {
  if (size === null) return { aspectRatio: String(4 / 3), maxWidth: "100%" };
  const ratio = Math.min(SINGLE_WIDEST, Math.max(SINGLE_TALLEST, size.width / size.height));
  return {
    aspectRatio: String(ratio),
    maxWidth: `min(100%, ${size.width}px, ${SINGLE_MAX_HEIGHT * ratio}rem)`,
  };
}

/** Whether a 4:3 thumbnail of a picture of `size` may crop it to fill the box; `photo` for a found photo. */
export function croppable(size: ImageSize | null, photo: boolean): boolean {
  if (size === null) return true;
  const [low, high] = photo ? PHOTO_CROPPABLE : PICTURE_CROPPABLE;
  const ratio = size.width / size.height;
  return ratio >= low && ratio <= high;
}
