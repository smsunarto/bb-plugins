// Vendored from dev.fast review/src/review-api/blocks/divider.ts @4ecc570 (MIT).
import { defineBlock } from "./definition.ts";

export const divider = {
  type: "divider",
  schema: defineBlock("divider", {}),
} as const;
