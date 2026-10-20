import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pinnedTargetSchema, targetSchema } from "./review.ts";

export const reviewHostContract = defineRpcContract({
  reviewSnapshot: {
    input: z
      .object({
        environmentPath: z.string().min(1),
        target: targetSchema,
      })
      .strict(),
    output: pinnedTargetSchema,
  },
  reviewRead: {
    input: z
      .object({
        target: pinnedTargetSchema,
        section: z.enum(["diff", "tree", "file"]),
        path: z.string().min(1).max(4096).optional(),
        side: z.enum(["base", "head"]),
        offset: z.number().int().min(0),
      })
      .strict(),
    output: z.object({
      text: z.string(),
      nextOffset: z.number().nullable(),
      totalLength: z.number(),
    }),
  },
});
