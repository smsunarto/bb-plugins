import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { changedFilesSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalChanges } from "../lib/gitbutler.ts";

const commitId = z.string().regex(/^[0-9a-fA-F]{4,64}$/, "Not a commit id.");

/** Everything an unpublished branch changes, `base..head`, read in its checkout. */
export const localChanges = defineQuery({
  input: z.strictObject({
    hostId: z.string().min(1),
    path: z.string().min(1),
    base: commitId,
    head: commitId,
  }),
  output: changedFilesSchema,
  async execute(ctx: CodeReviewContext, range) {
    return loadLocalChanges(ctx.bb, range);
  },
});
