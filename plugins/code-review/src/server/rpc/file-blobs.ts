import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { comparisonSchema, fileBlobsSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { withDeadline } from "../lib/deadline.ts";

const filePath = z.string().min(1).max(4096);

/**
 * What each side of a changed file holds, without its content: whether it
 * exists, its size, and the Git LFS object behind a pointer. A preview reads
 * this before it reads the file, and says what it cannot show.
 */
export const fileBlobs = defineQuery({
  input: z.strictObject({
    comparison: comparisonSchema,
    path: filePath,
    previousPath: filePath.nullable(),
  }),
  output: fileBlobsSchema,
  async execute(ctx: CodeReviewContext, { comparison, path, previousPath }) {
    return ctx.blobs.describe(comparison, path, previousPath, withDeadline(30_000));
  },
});
