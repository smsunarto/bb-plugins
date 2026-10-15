import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  patchesSchema,
  patchSourceSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const patches = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
      source: patchSourceSchema,
    })
    .strict(),
  output: patchesSchema,
  async execute(ctx, { threadId, checkout, repositoryKey, source }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
    if (!target) throw new Error(reason);
    return hostClient(ctx.bb).call(
      "patches",
      {
        ...repositoryTarget(target, repositoryKey),
        source,
      },
      { hostId: target.hostId },
    );
  },
});
