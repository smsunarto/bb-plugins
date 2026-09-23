import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import { baseHistorySchema, commitIdSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

export const baseHistory = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      from: commitIdSchema,
      offset: z.number().int().nonnegative().max(100_000),
      limit: z.number().int().min(1).max(500),
    })
    .strict(),
  output: baseHistorySchema,
  async execute(ctx, { threadId, repositoryKey, from, offset, limit }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) return { commits: [], hasMore: false, reason };
    return ctx.bb.hosts.experimental_client({ contract: gitbutlerHostContract }).call(
      "baseHistory",
      {
        environmentPath: target.environmentPath,
        ...(repositoryKey ? { repositoryKey } : {}),
        from,
        offset,
        limit,
      },
      { hostId: target.hostId },
    );
  },
});
