import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  observedCheckoutSchema,
  branchNameSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { reviewPrompt } from "../lib/prompts.ts";
import { claimReviewRequest } from "../lib/review-requests.ts";
import { locateRepository, spawnSubthread } from "../lib/subthreads.ts";

export const requestReviewContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
      /** The environment of the board the reader acted on. */
      environmentId: z.string().min(1).optional(),
      observed: observedCheckoutSchema.optional(),
      branch: branchNameSchema,
    })
    .strict(),
  output: z.object({ threadId: z.string() }).strict(),
};

/**
 * Create PR hands the branch to a visible child on the selected checkout.
 * The child uses GitButler or native Git according to that checkout's identity.
 */
export async function requestReview(
  ctx: GitButlerContext,
  {
    threadId,
    checkout,
    repositoryKey,
    environmentId,
    observed,
    branch,
  }: z.output<typeof requestReviewContract.input>,
): Promise<z.input<typeof requestReviewContract.output>> {
  const repository = await locateRepository(
    ctx.bb,
    threadId,
    repositoryKey,
    environmentId,
    checkout,
    observed,
    true,
  );
  if (repository.identity?.kind === "git" && repository.identity.branch !== branch) {
    throw new Error(
      "This checkout changed branches since the board was read. Refresh and try again.",
    );
  }
  const childId = await claimReviewRequest(ctx.bb, threadId, repository, branch, () =>
    spawnSubthread(ctx.bb, threadId, repository, {
      operation: "review",
      title: `Create PR for ${branch}`,
      prompt: reviewPrompt(branch, repository.path, repository.identity?.kind),
    }),
  );
  return { threadId: childId };
}
