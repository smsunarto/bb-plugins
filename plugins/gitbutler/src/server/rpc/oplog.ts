import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import { checkoutSelectionSchema, oplogSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const oplogContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: oplogSchema,
};

/**
 * GitButler's recent operations, read only. The panel never restores one: it
 * asks the agent to.
 */
export async function oplog(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey }: z.output<typeof oplogContract.input>,
): Promise<z.input<typeof oplogContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
  if (!target) return { entries: [], reason };
  return hostClient(ctx.bb).call("oplog", repositoryTarget(target, repositoryKey), {
    hostId: target.hostId,
  });
}
