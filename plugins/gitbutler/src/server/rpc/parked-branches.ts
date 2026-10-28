import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  parkedBranchesSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const parkedBranchesContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: parkedBranchesSchema,
};

/**
 * Local branches that are not applied to the workspace, read only. The panel
 * never applies one: it asks the agent to.
 */
export async function parkedBranches(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey }: z.output<typeof parkedBranchesContract.input>,
): Promise<z.input<typeof parkedBranchesContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
  if (!target) return { branches: [], hasMore: false, reason };
  return hostClient(ctx.bb).call("parkedBranches", repositoryTarget(target, repositoryKey), {
    hostId: target.hostId,
  });
}
