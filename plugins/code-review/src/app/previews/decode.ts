import type { DecodedImage } from "../../shared/previews.ts";
import { decodePsd } from "./psd.ts";
import { loadThreeKit } from "./three-kit.ts";

/*
 * Game-art images no browser draws, decoded to pixels here and handed back
 * as a PNG, so every image preview, whatever its format, compares two plain
 * `<img>` elements. A PNG object URL is inert: it cannot run as a page the
 * way an SVG one could.
 */

type Pixels = { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };

/**
 * The most pixels a preview decodes: 8192 × 4096 at 8 bits a channel, and a
 * quarter of that for float formats, which decode at 16 bytes a pixel. The
 * page decodes on its own thread, so a small file that declares a huge image
 * is refused from its header, before anything is allocated.
 */
const MAX_PIXELS = 8192 * 4096;
const MAX_FLOAT_PIXELS = 4096 * 4096;

type Size = { width: number; height: number };

function tiffSize(view: DataView): Size | null {
  const little = view.getUint16(0) === 0x4949;
  if (view.getUint16(2, little) !== 42) return null;
  const ifd = view.getUint32(4, little);
  const count = view.getUint16(ifd, little);
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = view.getUint16(entry, little);
    if (tag !== 256 && tag !== 257) continue;
    const value =
      view.getUint16(entry + 2, little) === 3
        ? view.getUint16(entry + 8, little)
        : view.getUint32(entry + 8, little);
    if (tag === 256) width = value;
    else height = value;
  }
  return width && height ? { width, height } : null;
}

function exrSize(view: DataView, bytes: Uint8Array): Size | null {
  if (view.getUint32(0, true) !== 0x01312f76) return null;
  const text = (from: number) => {
    const end = bytes.indexOf(0, from);
    return end < 0
      ? null
      : { value: new TextDecoder().decode(bytes.subarray(from, end)), next: end + 1 };
  };
  let at = 8;
  for (;;) {
    const name = text(at);
    if (!name || name.value === "") return null;
    const type = text(name.next);
    if (!type) return null;
    const size = view.getUint32(type.next, true);
    const value = type.next + 4;
    if (name.value === "dataWindow" && type.value === "box2i") {
      const width = view.getInt32(value + 8, true) - view.getInt32(value, true) + 1;
      const height = view.getInt32(value + 12, true) - view.getInt32(value + 4, true) + 1;
      return { width, height };
    }
    at = value + size;
  }
}

function hdrSize(bytes: Uint8Array): Size | null {
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 64 * 1024));
  const match = /\n\s*[-+]Y\s+(\d+)\s+[-+]X\s+(\d+)\s*\n/.exec(header);
  return match ? { width: Number(match[2]), height: Number(match[1]) } : null;
}

/** The size an image's header declares, read without decoding it. */
export function declaredSize(format: DecodedImage, buffer: ArrayBuffer): Size | null {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  try {
    if (format === "tga")
      return { width: view.getUint16(12, true), height: view.getUint16(14, true) };
    if (format === "psd") return { width: view.getUint32(18), height: view.getUint32(14) };
    if (format === "tif" || format === "tiff") return tiffSize(view);
    if (format === "exr") return exrSize(view, bytes);
    return hdrSize(bytes);
  } catch {
    // A header cut short is a file the loaders cannot read either.
    return null;
  }
}

function assertDecodable(format: DecodedImage, buffer: ArrayBuffer): void {
  const size = declaredSize(format, buffer);
  if (!size || size.width <= 0 || size.height <= 0)
    throw new Error("The image's size could not be read.");
  const max = format === "exr" || format === "hdr" ? MAX_FLOAT_PIXELS : MAX_PIXELS;
  if (size.width * size.height > max) {
    throw new Error(`The image is ${size.width} × ${size.height}, too large to preview here.`);
  }
}

/** Linear light to sRGB, clipped: an HDR texture's preview, not its grade. */
function toSrgb(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
}

function fromFloats(
  width: number,
  height: number,
  data: ArrayLike<number>,
  bottomUp: boolean,
): Pixels {
  const channels = Math.max(1, Math.round(data.length / (width * height)));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = bottomUp ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const from = (row * width + x) * channels;
      const to = (y * width + x) * 4;
      const r = data[from]!;
      out[to] = toSrgb(r);
      out[to + 1] = toSrgb(channels >= 3 ? data[from + 1]! : r);
      out[to + 2] = toSrgb(channels >= 3 ? data[from + 2]! : r);
      out[to + 3] =
        channels === 4 ? Math.round(Math.min(1, Math.max(0, data[from + 3]!)) * 255) : 255;
    }
  }
  return { width, height, data: out };
}

function fromBytes(
  width: number,
  height: number,
  data: ArrayLike<number>,
  bottomUp: boolean,
): Pixels {
  const out = new Uint8ClampedArray(width * height * 4);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const from = (bottomUp ? height - 1 - y : y) * row;
    for (let i = 0; i < row; i++) out[y * row + i] = data[from + i]!;
  }
  return { width, height, data: out };
}

type Texture = { width: number; height: number; data: ArrayLike<number>; flipY?: boolean };

async function pixelsOf(
  pluginId: string,
  format: DecodedImage,
  buffer: ArrayBuffer,
): Promise<Pixels> {
  assertDecodable(format, buffer);
  if (format === "psd") return decodePsd(buffer);
  const kit = await loadThreeKit(pluginId);
  // three's loaders mark data stored top row first with flipY, for the GPU.
  if (format === "tga") {
    const texture = new kit.TGALoader().parse(buffer) as Texture;
    return fromBytes(texture.width, texture.height, texture.data, texture.flipY === false);
  }
  if (format === "tif" || format === "tiff") {
    const texture = new kit.TIFFLoader().parse(buffer) as Texture;
    return fromBytes(texture.width, texture.height, texture.data, texture.flipY === false);
  }
  const loader =
    format === "exr"
      ? new kit.EXRLoader().setDataType(kit.FloatType)
      : new kit.HDRLoader().setDataType(kit.FloatType);
  const texture = loader.parse(buffer) as unknown as Texture;
  return fromFloats(texture.width, texture.height, texture.data, texture.flipY === false);
}

/** A decoded image as a PNG object URL, and its size. The caller revokes the URL. */
export async function decodeImage(
  pluginId: string,
  format: DecodedImage,
  buffer: ArrayBuffer,
): Promise<{ url: string; width: number; height: number }> {
  const pixels = await pixelsOf(pluginId, format, buffer);
  if (!pixels.width || !pixels.height) throw new Error("The image has no pixels.");
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw the image.");
  context.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("This browser cannot draw the image.");
  return { url: URL.createObjectURL(blob), width: pixels.width, height: pixels.height };
}
