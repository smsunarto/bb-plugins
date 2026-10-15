import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { checkoutSelectionSchema, oplogSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

/**
 * GitButler's recent operations, read only. The panel never restores one: it
 * asks the agent to.
 */
export const oplog = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: oplogSchema,
  async execute(ctx, { threadId, checkout, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
    if (!target) return { entries: [], reason };
    return hostClient(ctx.bb).call("oplog", repositoryTarget(target, repositoryKey), {
      hostId: target.hostId,
    });
  },
});
