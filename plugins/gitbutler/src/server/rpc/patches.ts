import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { patchesSchema, patchSourceSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { hostClient, resolveTarget } from "../lib/target.ts";

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
    return hostClient(ctx.bb).call(
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
