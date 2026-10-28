import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  conflictResolutionSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { readConflictResolution } from "../lib/conflict-resolution.ts";
import { locateForRead } from "../lib/subthreads.ts";

export const conflictResolutionContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: conflictResolutionSchema,
};

/** The Resolve conflicts subthread of the repository on screen, whichever thread started it. */
export async function conflictResolution(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey }: z.output<typeof conflictResolutionContract.input>,
): Promise<z.input<typeof conflictResolutionContract.output>> {
  const repository = await locateForRead(ctx.bb, threadId, repositoryKey, checkout);
  return { subthread: await readConflictResolution(ctx.bb, repository) };
}
