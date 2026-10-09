import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { oplogSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { hostClient, resolveTarget } from "../lib/target.ts";

/**
 * GitButler's recent operations, read only. The panel never restores one: it
 * asks the agent to.
 */
export const oplog = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: oplogSchema,
  async execute(ctx, { threadId, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) return { entries: [], reason };
    return hostClient(ctx.bb).call(
      "oplog",
      { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
      { hostId: target.hostId },
    );
  },
});
