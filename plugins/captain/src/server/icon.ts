import {
  ICON_IMAGE_MAX_BYTES,
  ICON_IMAGE_SIDE,
  type CaptainIcon,
  type IconChoice,
  type IconImageType,
} from "../contract/icon.ts";
import { iconTag, ICONS_TAG } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";

/** The raster type its leading bytes name; null for anything else, SVG included. */
export function sniffImageType(bytes: Buffer): IconImageType | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * An image's width and height from its header, without decoding it; null when
 * the header is cut short or malformed.
 */
export function imageSize(
  type: IconImageType,
  bytes: Buffer,
): { width: number; height: number } | null {
  try {
    switch (type) {
      case "png":
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      case "gif":
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
      case "webp":
        return webpSize(bytes);
      case "jpeg":
        return jpegSize(bytes);
    }
  } catch {
    return null;
  }
}

function webpSize(bytes: Buffer) {
  const chunk = bytes.subarray(12, 16).toString("latin1");
  if (chunk === "VP8 ")
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X")
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return null;
}

/** A JPEG's size from its first start-of-frame marker. */
function jpegSize(bytes: Buffer) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/** Text that opens like an SVG, to name the refusal; never a reason to accept one. */
function looksLikeSvg(bytes: Buffer): boolean {
  return /^\s*(<\?xml|<!--|<!DOCTYPE svg|<svg)/iu.test(bytes.subarray(0, 256).toString("utf8"));
}

export class IconImageError extends Error {}

/**
 * A file's bytes as the data URL Captain stores. Throws `IconImageError`
 * naming why it can't be: not a PNG, JPEG, GIF or WebP, over
 * `ICON_IMAGE_MAX_BYTES`, or larger than `ICON_IMAGE_SIDE` on a side.
 * The sidebar crops a non-square image to its centre square, as settings does.
 */
export function imageDataUrl(bytes: Buffer): string {
  const type = sniffImageType(bytes);
  if (type === null) {
    throw new IconImageError(
      looksLikeSvg(bytes)
        ? "SVG is not stored, since a hostile one can stall every client that draws it"
        : "the file is not a PNG, JPEG, GIF or WebP image",
    );
  }
  if (bytes.length > ICON_IMAGE_MAX_BYTES) {
    throw new IconImageError(
      `the image is ${Math.ceil(bytes.length / 1024)} KB; the most is ${ICON_IMAGE_MAX_BYTES / 1024} KB`,
    );
  }
  const size = imageSize(type, bytes);
  if (size === null) throw new IconImageError("the image's size could not be read");
  if (size.width > ICON_IMAGE_SIDE || size.height > ICON_IMAGE_SIDE) {
    throw new IconImageError(
      `the image is ${size.width}x${size.height} px; the most is ${ICON_IMAGE_SIDE}x${ICON_IMAGE_SIDE}`,
    );
  }
  return `data:image/${type};base64,${bytes.toString("base64")}`;
}

/** The decoded bytes of a stored data URL, to check one a client sent. */
export function dataUrlBytes(src: string): Buffer {
  return Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
}

/**
 * Set a live Captain's icon and refresh every list that draws it. An image is
 * re-read from its bytes, so a stored data URL always names its real type.
 */
export function setCaptainIcon(
  deps: Pick<CommandDeps, "bb" | "registry" | "store" | "now">,
  captainId: string,
  choice: IconChoice,
): CaptainIcon {
  if (deps.registry.get(captainId) === null) throw new Error(`${captainId} is not a live Captain`);
  const stored: IconChoice =
    choice?.kind === "image"
      ? { kind: "image", src: imageDataUrl(dataUrlBytes(choice.src)) }
      : choice;
  deps.store.setCaptainIcon(captainId, stored, deps.now());
  refreshIcon(deps, captainId);
  return deps.store.captainIcon(captainId);
}

/** Tell every list drawing this thread's icon to read it again, as when it becomes or stops being a Captain. */
export function refreshIcon(deps: Pick<CommandDeps, "bb">, captainId: string): void {
  deps.bb.rpc.experimental_invalidate([iconTag(captainId), ICONS_TAG]);
}

/**
 * The `icons` read: an entry for every key, null for a thread that is not a
 * live Captain. bb's keyed read fails the whole batch when a key is missing.
 */
export function captainIcons(
  deps: Pick<CommandDeps, "registry" | "store">,
  keys: readonly string[],
): Record<string, CaptainIcon | null> {
  const icons: Record<string, CaptainIcon | null> = {};
  for (const key of new Set(keys)) {
    icons[key] = deps.registry.get(key) === null ? null : deps.store.captainIcon(key);
  }
  return icons;
}
