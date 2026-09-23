import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import { commitDetailsSchema, commitIdSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

export const commit = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      commitId: commitIdSchema,
    })
    .strict(),
  output: commitDetailsSchema,
  async execute(ctx, { threadId, repositoryKey, commitId }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) throw new Error(reason);
    return ctx.bb.hosts.experimental_client({ contract: gitbutlerHostContract }).call(
      "commit",
      {
        environmentPath: target.environmentPath,
        ...(repositoryKey ? { repositoryKey } : {}),
        commitId,
      },
      { hostId: target.hostId },
    );
  },
});
