import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  branchNameSchema,
  repositoryKeySchema,
  reviewUrlSchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

/** The forge page of a branch's review, read when the reader asks to open it. */
export const reviewUrl = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
      branch: branchNameSchema,
    })
    .strict(),
  output: reviewUrlSchema,
  async execute(ctx, { threadId, checkout, repositoryKey, branch }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
    if (!target) throw new Error(reason);
    return hostClient(ctx.bb).call(
      "reviewUrl",
      {
        ...repositoryTarget(target, repositoryKey),
        branch,
      },
      { hostId: target.hostId },
    );
  },
});
