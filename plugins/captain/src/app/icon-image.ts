/**
 * Turn a picture the user picked into the PNG Captain stores: decoded in the
 * browser, cropped to its centre square, drawn at most `ICON_IMAGE_SIDE` px a
 * side, and encoded as PNG within `ICON_IMAGE_MAX_BYTES`. An SVG is drawn the
 * same way, so only a raster ever leaves the browser.
 */
import { ICON_IMAGE_MAX_BYTES, ICON_IMAGE_SIDE } from "../contract/icon.ts";

/** Sides tried in turn when a detailed picture's PNG is over the byte limit. */
const SIDES = [ICON_IMAGE_SIDE, 80, 64, 48, 32] as const;

/** The uploaded file as the PNG data URL `setIcon` accepts. */
export async function iconImage(file: File): Promise<string> {
  const picture = await loadPicture(file);
  try {
    const side = Math.min(picture.width, picture.height);
    for (const target of SIDES) {
      const canvas = document.createElement("canvas");
      canvas.width = target;
      canvas.height = target;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("This browser cannot scale the image.");
      context.drawImage(
        picture.source,
        (picture.width - side) / 2,
        (picture.height - side) / 2,
        side,
        side,
        0,
        0,
        target,
        target,
      );
      const url = canvas.toDataURL("image/png");
      if (dataUrlBytes(url) <= ICON_IMAGE_MAX_BYTES) return url;
    }
  } finally {
    picture.release();
  }
  throw new Error("That picture is too detailed to fit 16 KB; try a simpler one.");
}

type Picture = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

/** Decode a raster with `createImageBitmap`, and an SVG through an `<img>`, which can draw one. */
async function loadPicture(file: File): Promise<Picture> {
  if (file.type !== "image/svg+xml") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      throw new Error("That file is not an image this browser can read.");
    }
  }
  const sized = sizeSvg(await file.text());
  if (sized === null) throw new Error("That SVG could not be read.");
  const url = URL.createObjectURL(new Blob([sized.text], { type: "image/svg+xml" }));
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("That SVG could not be drawn.");
  }
  return {
    source: image,
    width: sized.width,
    height: sized.height,
    release: () => URL.revokeObjectURL(url),
  };
}

/** The size an SVG is drawn at before cropping: twice the stored side, for a clean downscale. */
const SVG_DRAW_SIDE = ICON_IMAGE_SIDE * 2;

/**
 * Give an SVG an explicit pixel size from its viewBox, so the browser draws
 * the whole drawing instead of a default 300x150 viewport cropped from it. The
 * shorter side becomes `SVG_DRAW_SIDE`. Null if the SVG cannot be sized.
 */
export function sizeSvg(text: string): { text: string; width: number; height: number } | null {
  const document = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.getElementsByTagName("parsererror").length > 0)
    return null;
  const style = root instanceof SVGSVGElement ? root.style : undefined;
  const { width, height, hasViewBox } = svgDimensions(root, style);
  const scale = SVG_DRAW_SIDE / Math.min(width, height);
  const drawn = { width: Math.round(width * scale), height: Math.round(height * scale) };
  if (!Number.isFinite(drawn.width) || !Number.isFinite(drawn.height)) return null;
  if (!hasViewBox) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  for (const axis of ["width", "height"] as const) {
    root.setAttribute(axis, String(drawn[axis]));
    // Inline CSS overrides the corresponding SVG presentation attribute.
    if (style?.getPropertyValue(axis)) {
      style.setProperty(axis, `${drawn[axis]}px`, style.getPropertyPriority(axis));
    }
  }
  root.setAttribute("preserveAspectRatio", "xMidYMid meet");
  return { text: new XMLSerializer().serializeToString(root), ...drawn };
}

function svgDimensions(root: Element, style: CSSStyleDeclaration | undefined) {
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  const [, , boxWidth = 0, boxHeight = 0] = box;
  if (box.length === 4 && boxWidth > 0 && boxHeight > 0) {
    return { width: boxWidth, height: boxHeight, hasViewBox: true };
  }
  return {
    width: pixels(style?.width || root.getAttribute("width")) ?? SVG_DRAW_SIDE,
    height: pixels(style?.height || root.getAttribute("height")) ?? SVG_DRAW_SIDE,
    hasViewBox: false,
  };
}

const PIXELS_PER_UNIT = new Map([
  ["", 1],
  ["px", 1],
  ["in", 96],
  ["cm", 96 / 2.54],
  ["mm", 96 / 25.4],
  ["q", 96 / 101.6],
  ["pt", 96 / 72],
  ["pc", 16],
]);

/** A unitless or absolute CSS length; null for a relative length or no size. */
function pixels(value: string | null): number | null {
  const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]*)\s*$/iu.exec(value ?? "");
  if (match === null) return null;
  const scale = PIXELS_PER_UNIT.get((match[2] ?? "").toLowerCase());
  if (scale === undefined) return null;
  const size = Number(match[1]) * scale;
  return Number.isFinite(size) && size > 0 ? size : null;
}

/** A base64 data URL's decoded size in bytes. */
function dataUrlBytes(url: string): number {
  const body = url.slice(url.indexOf(",") + 1);
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.floor((body.length * 3) / 4) - padding;
}
