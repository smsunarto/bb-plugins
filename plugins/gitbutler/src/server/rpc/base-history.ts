import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  baseHistorySchema,
  commitIdSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const baseHistory = defineQuery({
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
  async execute(ctx, { threadId, checkout, repositoryKey, from, offset, limit }) {
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
  },
});
