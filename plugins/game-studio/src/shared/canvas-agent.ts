import { z } from "zod";
import { gameInput, idSchema, nodeSchema } from "./schema.ts";

export const canvasContextInput = gameInput
  .extend({
    boardId: idSchema.optional(),
    nodeIds: z.array(idSchema).min(1).max(20).optional(),
    section: z.enum(["nodes", "edges", "assets", "documents"]).default("nodes"),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
    field: z
      .strictObject({
        nodeId: idSchema,
        key: z.string().min(1).max(200),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(8000).default(8000),
      })
      .optional(),
  })
  .strict()
  .refine((input) => !(input.nodeIds || input.field) || !!input.boardId, {
    message: "nodeIds and field require boardId.",
  })
  .refine((input) => !input.field || (input.section === "nodes" && !input.nodeIds), {
    message: "field requires section nodes and cannot be combined with nodeIds.",
  })
  .refine((input) => !input.nodeIds || input.section === "nodes", {
    message: "nodeIds requires section nodes.",
  });

// Publish a non-recursive input schema; parse arbitrary JSON at this boundary.
const agentData = z.record(z.string(), z.unknown()).pipe(nodeSchema.shape.data);

const nodePatch = nodeSchema
  .pick({ title: true, description: true, data: true })
  .partial()
  .extend({ data: agentData.optional() })
  .strict();
export const inputSelection = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("promptSource") }),
  z.strictObject({ key: z.literal("images"), index: z.number().int().nonnegative() }),
  z.strictObject({ key: z.literal("references"), index: z.number().int().nonnegative() }),
]);
export const canvasEditInput = gameInput
  .extend({
    boardId: idSchema,
    revision: z.string().min(1),
    dryRun: z.boolean().default(false),
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z.strictObject({
            op: z.literal("add_node"),
            node: nodeSchema
              .omit({ position: true, width: true, height: true })
              .extend({ data: agentData })
              .strict(),
          }),
          z.strictObject({ op: z.literal("update_node"), id: idSchema, patch: nodePatch }),
          z.strictObject({
            op: z.literal("move_node"),
            id: idSchema,
            position: nodeSchema.shape.position,
          }),
          z.strictObject({ op: z.literal("remove_node"), id: idSchema }),
          z.strictObject({
            op: z.literal("connect"),
            id: idSchema,
            source: idSchema,
            target: idSchema,
            port: z.string().min(1).max(100).optional(),
          }),
          z.strictObject({
            op: z.literal("connect_asset"),
            target: idSchema,
            assetId: z.string().min(1),
            port: z.string().min(1).max(100).optional(),
          }),
          z.strictObject({ op: z.literal("remove_input"), id: idSchema, input: inputSelection }),
          z.strictObject({ op: z.literal("disconnect"), id: idSchema }),
        ]),
      )
      .min(1)
      .max(100),
    /**
     * Run this node of the edited board once the edit is saved, its missing inputs first. A
     * paid run asks the person before anything is saved; a decline saves nothing.
     */
    run: z
      .strictObject({ nodeId: idSchema, requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
      .optional(),
  })
  .strict();

/** These references are also consumed by generation; preserve extra UI metadata. */
export const inputReference = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("node"),
    nodeId: idSchema,
    port: z.string().optional(),
    studioEdgeId: idSchema.optional(),
  }),
  z
    .looseObject({
      type: z.literal("library"),
      assetId: z.string().min(1),
      port: z.string().optional(),
    })
    .passthrough(),
]);
export const promptSource = z.looseObject({ type: z.literal("node"), nodeId: idSchema });
