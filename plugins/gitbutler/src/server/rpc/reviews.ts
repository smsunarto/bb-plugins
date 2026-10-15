import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  repositoryKeySchema,
  reviewsSchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

/** Each local branch's review on its forge, read apart from the workspace poll. */
export const reviews = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: reviewsSchema,
  async execute(ctx, { threadId, checkout, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
    if (!target) return { reviews: [], reason };
    return hostClient(ctx.bb).call("reviews", repositoryTarget(target, repositoryKey), {
      hostId: target.hostId,
    });
  },
});
