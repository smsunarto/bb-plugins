import { z } from "zod";
import { comparisonSchema, unityPreviewSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

const filePath = z.string().min(1).max(4096);

/** A Unity scene, prefab, asset, or `.meta` change as objects and properties. */
export const unityPreviewContract = {
  input: z.strictObject({
    comparison: comparisonSchema,
    path: filePath,
    previousPath: filePath.nullable(),
  }),
  output: unityPreviewSchema,
};

export async function unityPreview(
  ctx: CodeReviewContext,
  { comparison, path, previousPath }: z.output<typeof unityPreviewContract.input>,
): Promise<z.input<typeof unityPreviewContract.output>> {
  return ctx.unity.read(comparison, path, previousPath);
}
