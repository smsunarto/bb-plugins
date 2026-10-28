import { z } from "zod";
import { branchIdSchema, branchKey } from "../../shared/schema.ts";
import { linkThread, runningReview } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { requireLocalBranch } from "../lib/gitbutler.ts";
import { createLocks } from "../lib/lock.ts";
import { localReviewTarget } from "../lib/projects.ts";
import { localReviewPrompt } from "../lib/prompts.ts";

// One review per branch head at a time; see `startReview`.
const withLock = createLocks();

/**
 * Starts a read-only bb review of an unpublished branch at its current head,
 * in the checkout that holds it. Asking again while a review of the same
 * head runs returns that review.
 */
export const startLocalReviewContract = {
  input: z.strictObject({ id: branchIdSchema }),
  output: z.strictObject({ threadId: z.string() }),
};

export async function startLocalReview(
  ctx: CodeReviewContext,
  { id }: z.output<typeof startLocalReviewContract.input>,
): Promise<z.input<typeof startLocalReviewContract.output>> {
  const branch = await requireLocalBranch(ctx.bb, id);
  const key = branchKey(id);
  // The base is a commit, so a branch rebased onto another base reads as another revision.
  const revision = { headRefOid: branch.head, baseRefName: branch.base };
  return withLock(key, async () => {
    const running = await runningReview(ctx.bb, ctx.store, key, revision);
    if (running) return { threadId: running };

    const { projectId, environment } = await localReviewTarget(ctx.bb, branch);
    const thread = await ctx.bb.sdk.threads.spawn({
      projectId,
      environment,
      reasoningLevel: "high",
      visibility: "visible",
      title: `Review ${branch.branch}`,
      pluginMetadata: { kind: "review", branch: id, headRefOid: branch.head },
      prompt: localReviewPrompt(branch, await ctx.store.instructions()),
    });
    await linkThread(ctx.bb, ctx.store, key, {
      threadId: thread.id,
      kind: "review",
      ...revision,
    });
    return { threadId: thread.id };
  });
}
