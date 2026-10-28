import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  repositoryKeySchema,
  reviewsSchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const reviewsContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: reviewsSchema,
};

/** Each local branch's review on its forge, read apart from the workspace poll. */
export async function reviews(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey }: z.output<typeof reviewsContract.input>,
): Promise<z.input<typeof reviewsContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
  if (!target) return { reviews: [], reason };
  return hostClient(ctx.bb).call("reviews", repositoryTarget(target, repositoryKey), {
    hostId: target.hostId,
  });
}
