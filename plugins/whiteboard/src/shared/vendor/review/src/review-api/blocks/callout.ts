// Vendored from dev.fast review/src/review-api/blocks/callout.ts @4ecc570 (MIT).
import { z } from "zod";

import { type BlockDefinition, defineBlock, label } from "./definition.ts";
import { type Block, blockSchema } from "./index.ts";

export interface CalloutBlock {
  id?: string;
  type: "callout";
  title?: string;
  tone: "info" | "warning" | "danger" | "success";
  children: Block[];
}

// blockSchema is read inside z.lazy, after every module in the cycle has evaluated.
const schema: z.ZodType<CalloutBlock> = defineBlock("callout", {
  title: label.optional(),
  tone: z.enum(["info", "warning", "danger", "success"]).default("info"),
  children: z.array(z.lazy((): z.ZodType<Block> => blockSchema)),
});

export const callout: BlockDefinition<CalloutBlock> = {
  type: "callout",
  schema,
};
