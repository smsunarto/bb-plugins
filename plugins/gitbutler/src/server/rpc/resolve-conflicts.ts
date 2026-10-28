import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  observedCheckoutSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { assertCheckoutIdle, inCheckout } from "../lib/checkout-ownership.ts";
import { claimConflictResolution } from "../lib/conflict-resolution.ts";
import { conflictPrompt } from "../lib/prompts.ts";
import { locateRepository, prepareCheckoutChild, spawnSubthread } from "../lib/subthreads.ts";

export const resolveConflictsContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
      /** The environment of the board the reader acted on. */
      environmentId: z.string().min(1).optional(),
      observed: observedCheckoutSchema.optional(),
    })
    .strict(),
  output: z.object({ threadId: z.string() }).strict(),
};

/**
 * Resolve conflicts hands every conflict in the selected repository to one
 * visible child, using that checkout's Git driver. The repository keeps that one
 * subthread until it is archived: asking while it works returns it, from this
 * thread or another on the same workspace, and asking once it stopped sends
 * it the job again. It may have stopped to ask the user something, and a
 * second resolver would rewrite the same commits.
 */
export async function resolveConflicts(
  ctx: GitButlerContext,
  {
    threadId,
    checkout,
    repositoryKey,
    environmentId,
    observed,
  }: z.output<typeof resolveConflictsContract.input>,
): Promise<z.input<typeof resolveConflictsContract.output>> {
  const repository = await locateRepository(
    ctx.bb,
    threadId,
    repositoryKey,
    environmentId,
    checkout,
    observed,
    true,
  );
  const prompt = conflictPrompt(repository.path, repository.identity?.kind);
  const childId = await claimConflictResolution(ctx.bb, repository, async (current) => {
    if (current?.running) return current.threadId;
    if (checkout || repository.identity?.kind === "git") {
      await locateRepository(
        ctx.bb,
        threadId,
        repositoryKey,
        environmentId,
        checkout,
        observed,
        true,
      );
    }
    if (current) {
      const resume = async () => {
        if (checkout || repository.identity?.kind === "git") {
          await assertCheckoutIdle(ctx.bb, threadId, repository);
          await prepareCheckoutChild(ctx.bb, threadId, repository, "conflicts");
        }
        await ctx.bb.sdk.threads.send({
          threadId: current.threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: prompt, mentions: [] }],
        });
        return current.threadId;
      };
      return checkout || repository.identity?.kind === "git"
        ? inCheckout(ctx.bb, repository, resume)
        : resume();
    }
    // The folder name, on either kind of host path.
    const name = repository.path.split(/[\\/]/).findLast(Boolean) ?? repository.key;
    return spawnSubthread(ctx.bb, threadId, repository, {
      operation: "conflicts",
      title: `Resolve conflicts in ${name}`,
      prompt,
    });
  });
  return { threadId: childId };
}
