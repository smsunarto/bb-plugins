// Vendored from dev.fast review/src/review-api/blocks/index.ts @4ecc570 (MIT).
import { z } from "zod";

import { call_stack_diff } from "./call_stack_diff.ts";
import { type CalloutBlock, callout } from "./callout.ts";
import { code } from "./code.ts";
import { code_peek } from "./code_peek.ts";
import { database_lens } from "./database_lens.ts";
import type { BlockDefinition } from "./definition.ts";
import { divider } from "./divider.ts";
import { flow_diagram } from "./flow_diagram.ts";
import { image } from "./image.ts";
import { markdown } from "./markdown.ts";
import { type SectionBlock, section } from "./section.ts";
import { sequence } from "./sequence.ts";
import { software_map } from "./software_map.ts";
import { trace_quote } from "./trace_quote.ts";
import { type TutorialBlock, tutorial } from "./tutorial.ts";

/** Leaf kinds share one discriminated union so unknown types read as they always have. */
export const leafSchema = z.discriminatedUnion("type", [
  markdown.schema,
  code.schema,
  divider.schema,
  code_peek.schema,
  sequence.schema,
  call_stack_diff.schema,
  database_lens.schema,
  image.schema,
  trace_quote.schema,
  software_map.schema,
  flow_diagram.schema,
]);

export type LeafBlock = z.infer<typeof leafSchema>;

export type Block = LeafBlock | SectionBlock | CalloutBlock | TutorialBlock;

export type BlockType = Block["type"];

export type Definitions = {
  [K in BlockType]: BlockDefinition<Extract<Block, { type: K }>>;
};

/** Every block kind, keyed by type. A kind without a definition is a compile error. */
export const blocks = {
  markdown,
  code,
  divider,
  code_peek,
  sequence,
  call_stack_diff,
  database_lens,
  image,
  trace_quote,
  software_map,
  flow_diagram,
  section,
  callout,
  tutorial,
} satisfies Definitions;

export const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.union([leafSchema, section.schema, callout.schema, tutorial.schema]),
);

function checkBlock<K extends BlockType>(
  type: K,
  block: Extract<Block, { type: K }>,
): void {
  const definition: Definitions[K] = blocks[type];
  definition.check?.(block);
}

/** Relationships not expressible in a field schema. Sources/resources are checked by host providers. */
export function checkReferences(document: Block[]): void {
  const visit = (block: Block) => {
    checkBlock(block.type, block);

    if ("children" in block) block.children.forEach(visit);
  };

  document.forEach(visit);
}
