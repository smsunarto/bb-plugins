import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { repositoryKeySchema, reviewsSchema } from "../../shared/schema.ts";
import { hostClient, resolveTarget } from "../lib/target.ts";

/** Each local branch's review on its forge, read apart from the workspace poll. */
export const reviews = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: reviewsSchema,
  async execute(ctx, { threadId, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) return { reviews: [], reason };
    return hostClient(ctx.bb).call(
      "reviews",
      { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
      { hostId: target.hostId },
    );
  },
});
