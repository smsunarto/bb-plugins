import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import { oplogSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

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
    return ctx.bb.hosts
      .experimental_client({ contract: gitbutlerHostContract })
      .call(
        "oplog",
        { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
        { hostId: target.hostId },
      );
  },
});
