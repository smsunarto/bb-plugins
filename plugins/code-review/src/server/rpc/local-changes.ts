import { z } from "zod";
import { changedFilesSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalChanges } from "../lib/gitbutler.ts";

const commitId = z.string().regex(/^[0-9a-fA-F]{4,64}$/, "Not a commit id.");

/** Everything an unpublished branch changes, `base..head`, read in its checkout. */
export const localChangesContract = {
  input: z.strictObject({
    hostId: z.string().min(1),
    path: z.string().min(1),
    base: commitId,
    head: commitId,
  }),
  output: changedFilesSchema,
};

export async function localChanges(
  ctx: CodeReviewContext,
  range: z.output<typeof localChangesContract.input>,
): Promise<z.input<typeof localChangesContract.output>> {
  return loadLocalChanges(ctx.bb, range);
}
