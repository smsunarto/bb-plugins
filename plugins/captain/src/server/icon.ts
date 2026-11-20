import {
  ICON_IMAGE_MAX_BYTES,
  ICON_IMAGE_TYPES,
  type CaptainIcon,
  type IconChoice,
} from "../contract/icon.ts";
import { iconTag, ICONS_TAG } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";

type ImageType = (typeof ICON_IMAGE_TYPES)[number];

/** The image type its leading bytes name; null for anything an `<img>` should not draw. */
export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  // An SVG is text: skip a BOM, an XML declaration, comments and a doctype to its root.
  const text = bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/u, "");
  const root = text.replace(/^(\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/iu, "");
  if (/^<svg[\s>]/iu.test(root)) return "svg+xml";
  return null;
}

export class IconImageError extends Error {}

/** A file's bytes as the data URL Captain stores; throws `IconImageError` naming why it can't be. */
export function imageDataUrl(bytes: Buffer): string {
  if (bytes.length > ICON_IMAGE_MAX_BYTES) {
    throw new IconImageError(
      `the image is ${Math.ceil(bytes.length / 1024)} KB; the most is ${ICON_IMAGE_MAX_BYTES / 1024} KB`,
    );
  }
  const type = sniffImageType(bytes);
  if (type === null)
    throw new IconImageError("the file is not a PNG, JPEG, GIF, WebP or SVG image");
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

/** The `icons` read: an entry for each key that is a live Captain. */
export function captainIcons(
  deps: Pick<CommandDeps, "registry" | "store">,
  keys: readonly string[],
): Record<string, CaptainIcon> {
  const icons: Record<string, CaptainIcon> = {};
  for (const key of new Set(keys)) {
    if (deps.registry.get(key) !== null) icons[key] = deps.store.captainIcon(key);
  }
  return icons;
}
