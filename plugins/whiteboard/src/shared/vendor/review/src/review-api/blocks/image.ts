// Vendored from dev.fast review/src/review-api/blocks/image.ts @4ecc570 (MIT).
import { defineBlock, label, text } from "./definition.ts";

export const image = {
  type: "image",
  schema: defineBlock("image", {
    assetId: label,
    alt: label,
    caption: text.optional(),
  }),
} as const;
