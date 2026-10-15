import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  parkedBranchesSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

/**
 * Local branches that are not applied to the workspace, read only. The panel
 * never applies one: it asks the agent to.
 */
export const parkedBranches = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: parkedBranchesSchema,
  async execute(ctx, { threadId, checkout, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
    if (!target) return { branches: [], hasMore: false, reason };
    return hostClient(ctx.bb).call("parkedBranches", repositoryTarget(target, repositoryKey), {
      hostId: target.hostId,
    });
  },
});
