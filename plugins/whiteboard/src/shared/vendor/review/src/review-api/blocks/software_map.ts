// Vendored from dev.fast review/src/review-api/blocks/software_map.ts @4ecc570 (MIT).
import { defineBlock, label } from "./definition.ts";

export const software_map = {
  type: "software_map",
  schema: defineBlock("software_map", {
    mapVersionId: label,
    focusElementId: label.optional(),
  }),
} as const;
