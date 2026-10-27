import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { comparisonSchema, unityPreviewSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

const filePath = z.string().min(1).max(4096);

/** A Unity scene, prefab, asset, or `.meta` change as objects and properties. */
export const unityPreview = defineQuery({
  input: z.strictObject({
    comparison: comparisonSchema,
    path: filePath,
    previousPath: filePath.nullable(),
  }),
  output: unityPreviewSchema,
  async execute(ctx: CodeReviewContext, { comparison, path, previousPath }) {
    return ctx.unity.read(comparison, path, previousPath);
  },
});
