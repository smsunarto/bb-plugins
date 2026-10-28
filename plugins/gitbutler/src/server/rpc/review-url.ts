import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  branchNameSchema,
  repositoryKeySchema,
  reviewUrlSchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const reviewUrlContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
      branch: branchNameSchema,
    })
    .strict(),
  output: reviewUrlSchema,
};

/** The forge page of a branch's review, read when the reader asks to open it. */
export async function reviewUrl(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey, branch }: z.output<typeof reviewUrlContract.input>,
): Promise<z.input<typeof reviewUrlContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
  if (!target) throw new Error(reason);
  return hostClient(ctx.bb).call(
    "reviewUrl",
    {
      ...repositoryTarget(target, repositoryKey),
      branch,
    },
    { hostId: target.hostId },
  );
}
