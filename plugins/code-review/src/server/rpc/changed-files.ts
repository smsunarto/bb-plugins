import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { changedFilesSchema, prRefSchema } from "../../shared/schema.ts";
import { loadChangedFiles } from "../lib/changed-files.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Every changed file's patch and the viewer's "viewed" mark on it. */
export const changedFiles = defineQuery({
  input: z.strictObject({ ref: prRefSchema }),
  output: changedFilesSchema,
  async execute(ctx: CodeReviewContext, { ref }) {
    return loadChangedFiles(ctx.gh, ref);
  },
});
