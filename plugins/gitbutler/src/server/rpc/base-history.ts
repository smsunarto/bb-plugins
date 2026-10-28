import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  baseHistorySchema,
  commitIdSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const baseHistoryContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
      from: commitIdSchema,
      offset: z.number().int().nonnegative().max(100_000),
      limit: z.number().int().min(1).max(500),
    })
    .strict(),
  output: baseHistorySchema,
};

export async function baseHistory(
  ctx: GitButlerContext,
  {
    threadId,
    checkout,
    repositoryKey,
    from,
    offset,
    limit,
  }: z.output<typeof baseHistoryContract.input>,
): Promise<z.input<typeof baseHistoryContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
  if (!target) return { commits: [], hasMore: false, reason };
  return hostClient(ctx.bb).call(
    "baseHistory",
    {
      ...repositoryTarget(target, repositoryKey),
      from,
      offset,
      limit,
    },
    { hostId: target.hostId },
  );
}
