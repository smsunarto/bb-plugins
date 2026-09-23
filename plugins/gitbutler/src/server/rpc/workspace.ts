import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import { repositoryKeySchema, workspaceSchema } from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

export const workspace = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: workspaceSchema,
  async execute(ctx, { threadId, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) {
      return {
        state: "noEnvironment" as const,
        reason,
        repoName: "",
        unassignedChanges: [],
        stacks: [],
        base: null,
        upstream: null,
        revision: `noEnvironment:${reason}`,
      };
    }
    return ctx.bb.hosts
      .experimental_client({ contract: gitbutlerHostContract })
      .call(
        "workspace",
        { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
        { hostId: target.hostId },
      );
  },
});
