import {
  ICON_IMAGE_MAX_BYTES,
  ICON_IMAGE_PREFIX,
  ICON_IMAGE_SIDE,
  type CaptainIcon,
  type IconChoice,
} from "../contract/icon.ts";
import { iconTag, ICONS_TAG } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The IEND chunk every complete PNG ends with: length 0, type, CRC. */
const PNG_END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export class IconImageError extends Error {}

/**
 * Check an image as Captain settings makes it: a PNG of at most
 * `ICON_IMAGE_MAX_BYTES`, whose header gives at most `ICON_IMAGE_SIDE` px a
 * side, ending in IEND. Throws `IconImageError` naming what is wrong.
 */
export function checkIconPng(bytes: Buffer): void {
  if (bytes.length > ICON_IMAGE_MAX_BYTES) {
    throw new IconImageError(
      `the image is ${Math.ceil(bytes.length / 1024)} KB; the most is ${ICON_IMAGE_MAX_BYTES / 1024} KB`,
    );
  }
  const complete =
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.subarray(12, 16).toString("latin1") === "IHDR" &&
    bytes.subarray(-12).equals(PNG_END);
  if (!complete) throw new IconImageError("the image is not a complete PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > ICON_IMAGE_SIDE || height > ICON_IMAGE_SIDE) {
    throw new IconImageError(
      `the image is ${width}x${height} px; the most is ${ICON_IMAGE_SIDE}x${ICON_IMAGE_SIDE}`,
    );
  }
}

/** The decoded bytes of a stored data URL, to check one a client sent. */
export function dataUrlBytes(src: string): Buffer {
  return Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
}

/**
 * Set a live Captain's icon and refresh every list that draws it. An image
 * must be the PNG Captain settings makes; see `checkIconPng`.
 */
export function setCaptainIcon(
  deps: Pick<CommandDeps, "bb" | "registry" | "store" | "now">,
  captainId: string,
  choice: IconChoice,
): CaptainIcon {
  if (deps.registry.get(captainId) === null) throw new Error(`${captainId} is not a live Captain`);
  let stored = choice;
  if (choice?.kind === "image") {
    const bytes = dataUrlBytes(choice.src);
    checkIconPng(bytes);
    stored = { kind: "image", src: ICON_IMAGE_PREFIX + bytes.toString("base64") };
  }
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
