import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  repositoryKeySchema,
  reviewRequestsSchema,
} from "../../shared/schema.ts";
import { readReviewRequests } from "../lib/review-requests.ts";
import { locateForRead } from "../lib/subthreads.ts";

export const reviewRequestsContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: reviewRequestsSchema,
};

/** The Create PR subthreads this thread started for the repository on screen. */
export async function reviewRequests(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey }: z.output<typeof reviewRequestsContract.input>,
): Promise<z.input<typeof reviewRequestsContract.output>> {
  const repository = await locateForRead(ctx.bb, threadId, repositoryKey, checkout);
  return { requests: await readReviewRequests(ctx.bb, threadId, repository) };
}
