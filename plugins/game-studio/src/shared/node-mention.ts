import { z } from "zod";
import { idSchema } from "./schema.ts";

/** `@` a canvas node in the composer: the agent gets its brief, inputs, and output as context. */
export const NODE_MENTION_PROVIDER = "canvas-node";
export const nodeMentionRef = z.strictObject({
  gameId: idSchema,
  boardId: idSchema,
  nodeId: idSchema,
});
export type NodeMentionRef = z.infer<typeof nodeMentionRef>;
export const nodeMentionId = (ref: NodeMentionRef) => JSON.stringify(ref);
