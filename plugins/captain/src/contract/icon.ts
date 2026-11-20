/**
 * A Captain's sidebar icon: bb's default Captain glyph, one of bb's icon names,
 * or a small image. Thread lists read it through the keyed `icons` RPC, so the
 * shapes here are public; gtd-sidebar mirrors them.
 */
import { z } from "zod";

/** The glyph a Captain with no icon of its own shows: `bb.branding.experimental_icons.captain`. */
export const DEFAULT_ICON_GLYPH = "captain/captain";

/** An image's largest decoded size; the settings upload scales a picture down to fit. */
export const ICON_IMAGE_MAX_BYTES = 128 * 1024;

/** The image types an `<img>` draws from a data URL, by the bytes that start each one. */
export const ICON_IMAGE_TYPES = ["png", "jpeg", "gif", "webp", "svg+xml"] as const;

/** A name from bb's built-in icon set, in its PascalCase: `Star`, `AiBrain01`. */
export const iconNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/u);

const imageSrcSchema = z
  .string()
  .max(ICON_IMAGE_MAX_BYTES * 2)
  .regex(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u);

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
 * `aiBrain01` all give `AiBrain01`. Null when it cannot be one.
 */
export function normalizeIconName(raw: string): string | null {
  const words = raw
    .trim()
    .split(/[-_\s]+/u)
    .filter(Boolean);
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return iconNameSchema.safeParse(name).success ? name : null;
}
