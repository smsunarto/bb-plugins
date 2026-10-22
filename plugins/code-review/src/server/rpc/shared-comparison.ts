import { defineQuery } from "@bb-kit/core/rpc";
import { localComparisonSchema, sharedComparisonInputSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Resolve the checkout without requiring a still-unpublished branch or scanning other hosts. */
export const sharedComparison = defineQuery({
  input: sharedComparisonInputSchema,
  output: localComparisonSchema,
  async execute(ctx: CodeReviewContext, { threadId, ...range }) {
    const location = await ctx.store.branchLocation(range.id);
    if (location) return { ...range, ...location };
    // Older cards retained only their commit IDs. Their own thread supplies
    // the checkout; localChanges still verifies it against BB's known paths.
    if (threadId) {
      const thread = await ctx.bb.sdk.threads.get({ threadId, include: "environment" });
      const environment = "environment" in thread ? thread.environment : null;
      if (environment?.path && environment.status === "ready")
        return { ...range, hostId: environment.hostId, path: environment.path };
    }
    throw new Error("The checkout for these shared commits is no longer available.");
  },
});
