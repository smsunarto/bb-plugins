/**
 * A Captain's sidebar icon: bb's default Captain glyph, one of bb's icon names,
 * or a small image. Thread lists read it through the keyed `icons` RPC, so the
 * shapes here are public; gtd-sidebar mirrors them.
 */
import { z } from "zod";

/** The glyph a Captain with no icon of its own shows: `bb.branding.experimental_icons.captain`. */
export const DEFAULT_ICON_GLYPH = "captain/captain";

/**
 * An image's largest side in pixels. The sidebar draws 12 px and settings
 * 16 px, so 96 covers a 3x screen with room; settings scales an upload to it.
 */
export const ICON_IMAGE_SIDE = 96;

/** An image's largest size in bytes: a 96 px picture fits, and every read stays small. */
export const ICON_IMAGE_MAX_BYTES = 16 * 1024;

/**
 * Images are set only in Captain settings, which decodes the user's picture
 * in the browser and re-encodes it as a PNG of at most `ICON_IMAGE_SIDE` px.
 * Captain stores that PNG and nothing else: no SVG, which a small hostile file
 * can make stall every client that draws it, and no file read on the server.
 */
export const ICON_IMAGE_PREFIX = "data:image/png;base64,";

/** A name from bb's built-in icon set, in its PascalCase: `Star`, `AiBrain01`. */
const iconNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/u);

const imageSrcSchema = z
  .string()
  .max(ICON_IMAGE_PREFIX.length + Math.ceil(ICON_IMAGE_MAX_BYTES / 3) * 4)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u);

export const captainIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("icon"), name: iconNameSchema }).strict(),
  z.object({ kind: z.literal("image"), src: imageSrcSchema }).strict(),
]);
export type CaptainIcon = z.infer<typeof captainIconSchema>;

/** What a setter writes: an icon name, an image as a data URL, or null for the default. */
export const iconChoiceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("icon"), name: iconNameSchema }).strict(),
    z.object({ kind: z.literal("image"), src: imageSrcSchema }).strict(),
  ])
  .nullable();
export type IconChoice = z.infer<typeof iconChoiceSchema>;

/**
 * Read a typed icon name in bb's PascalCase: `ai-brain-01`, `ai_brain_01` and
 * `aiBrain01` all give `AiBrain01`, and `SHIP-WHEEL` gives `ShipWheel`. Null
 * when it cannot be one.
 */
export function normalizeIconName(raw: string): string | null {
  const words = raw
    .trim()
    .split(/[-_\s]+/u)
    .filter(Boolean)
    // An all-capitals word is shouting, not PascalCase.
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word.toLowerCase() : word));
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return iconNameSchema.safeParse(name).success ? name : null;
}
