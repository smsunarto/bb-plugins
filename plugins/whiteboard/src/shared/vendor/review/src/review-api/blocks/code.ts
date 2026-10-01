// Vendored from dev.fast review/src/review-api/blocks/code.ts @4ecc570 (MIT).
import { defineBlock, text } from "./definition.ts";

/** Shared with sequence steps. */
export const codeFields = { language: text.default("text"), text };

export const code = {
  type: "code",
  schema: defineBlock("code", { ...codeFields, caption: text.optional() }),
} as const;
