import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { branchNameSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { reviewPrompt } from "../lib/review-prompt.ts";
import {
  locateRepository,
  readReviewRequests,
  recordReviewRequest,
} from "../lib/review-requests.ts";

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
      branch: branchNameSchema,
    })
    .strict(),
  output: z.object({ threadId: z.string() }).strict(),
  async execute(ctx, { threadId, repositoryKey, branch }) {
    const repository = await locateRepository(ctx.bb, threadId, repositoryKey);
    // One subthread per branch: asking again while it works returns the same one.
    const running = (await readReviewRequests(ctx.bb, threadId, repository.key)).find(
      (request) => request.branch === branch && request.running,
    );
    if (running) return { threadId: running.threadId };

    const thread = await ctx.bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no project environment.");
    const child = await ctx.bb.sdk.threads.spawn({
      projectId: thread.projectId,
      environment: { type: "reuse", environmentId: thread.environmentId },
      providerId: thread.providerId,
      parentThreadId: threadId,
      title: `Create PR for ${branch}`,
      prompt: reviewPrompt(branch, repository.path),
    });
    await recordReviewRequest(ctx.bb, threadId, {
      repositoryKey: repository.key,
      branch,
      threadId: child.id,
    });
    return { threadId: child.id };
  },
});
