import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { branchNameSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { reviewPrompt } from "../lib/prompts.ts";
import { claimReviewRequest } from "../lib/review-requests.ts";
import { locateRepository, spawnSubthread } from "../lib/subthreads.ts";

/**
 * Create PR hands the branch to a subthread of the reader's thread. It shares
 * the thread's environment, so it runs `but` on the same workspace, and it is
 * a visible child, so the reader can watch it and answer it.
 */
export const requestReview = defineMutation({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      /** The environment of the board the reader acted on. */
      environmentId: z.string().min(1).optional(),
      branch: branchNameSchema,
    })
    .strict(),
  output: z.object({ threadId: z.string() }).strict(),
  async execute(ctx, { threadId, repositoryKey, environmentId, branch }) {
    const repository = await locateRepository(ctx.bb, threadId, repositoryKey, environmentId);
    const childId = await claimReviewRequest(ctx.bb, threadId, repository, branch, () =>
      spawnSubthread(ctx.bb, threadId, repository, {
        title: `Create PR for ${branch}`,
        prompt: reviewPrompt(branch, repository.path),
      }),
    );
    return { threadId: childId };
  },
});
