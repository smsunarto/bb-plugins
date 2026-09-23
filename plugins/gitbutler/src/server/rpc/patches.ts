import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import { patchesSchema, patchSourceSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

export const patches = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      source: patchSourceSchema,
    })
    .strict(),
  output: patchesSchema,
  async execute(ctx, { threadId, repositoryKey, source }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) throw new Error(reason);
    return ctx.bb.hosts.experimental_client({ contract: gitbutlerHostContract }).call(
      "patches",
      {
        environmentPath: target.environmentPath,
        ...(repositoryKey ? { repositoryKey } : {}),
        source,
      },
      { hostId: target.hostId },
    );
  },
});
