// Vendored from dev.fast review/src/review-api/blocks/code_peek.ts @4ecc570 (MIT).
import { diffSelectionSchema } from "../../lens-selection.ts";
import { defineBlock, text } from "./definition.ts";

export const code_peek = {
  type: "code_peek",
  schema: defineBlock("code_peek", {
    source: diffSelectionSchema,
    // Not rendered yet.
    caption: text.optional(),
  }),
} as const;
