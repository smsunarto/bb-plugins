import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { parkedBranchesSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { hostClient, resolveTarget } from "../lib/target.ts";

/**
 * Local branches that are not applied to the workspace, read only. The panel
 * never applies one: it asks the agent to.
 */
export const parkedBranches = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: parkedBranchesSchema,
  async execute(ctx, { threadId, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) return { branches: [], hasMore: false, reason };
    return hostClient(ctx.bb).call(
      "parkedBranches",
      { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
      { hostId: target.hostId },
    );
  },
});
