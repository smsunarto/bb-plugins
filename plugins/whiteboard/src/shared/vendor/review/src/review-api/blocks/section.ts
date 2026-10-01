// Vendored from dev.fast review/src/review-api/blocks/section.ts @4ecc570 (MIT).
import { z } from "zod";

import { type BlockDefinition, defineBlock, label } from "./definition.ts";
import { type Block, blockSchema } from "./index.ts";

export interface SectionBlock {
  id?: string;
  type: "section";
  title: string;
  defaultCollapsed?: boolean;
  children: Block[];
}

// blockSchema is read inside z.lazy, after every module in the cycle has evaluated.
const schema: z.ZodType<SectionBlock> = defineBlock("section", {
  title: label,
  defaultCollapsed: z.boolean().optional(),
  children: z.array(z.lazy((): z.ZodType<Block> => blockSchema)),
});

export const section: BlockDefinition<SectionBlock> = {
  type: "section",
  schema,
};
