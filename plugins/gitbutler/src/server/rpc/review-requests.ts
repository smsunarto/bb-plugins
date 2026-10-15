import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  repositoryKeySchema,
  reviewRequestsSchema,
} from "../../shared/schema.ts";
import { readReviewRequests } from "../lib/review-requests.ts";
import { locateRepository } from "../lib/subthreads.ts";

/** The Create PR subthreads this thread started for the repository on screen. */
export const reviewRequests = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: reviewRequestsSchema,
  async execute(ctx, { threadId, checkout, repositoryKey }) {
    const repository = await locateRepository(ctx.bb, threadId, repositoryKey, undefined, checkout);
    return { requests: await readReviewRequests(ctx.bb, threadId, repository) };
  },
});
