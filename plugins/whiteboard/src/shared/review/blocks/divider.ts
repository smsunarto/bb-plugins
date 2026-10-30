import { defineBlock } from "./definition.ts";

export const divider = {
  type: "divider",
  schema: defineBlock("divider", {}),
} as const;
