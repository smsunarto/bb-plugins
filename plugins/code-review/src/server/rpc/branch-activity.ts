import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { agentActivitySchema, branchIdSchema, branchKey } from "../../shared/schema.ts";
import { agentActivity as readActivity } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** The bb reviews started for an unpublished branch, and the findings to show. */
export const branchActivity = defineQuery({
  input: z.strictObject({ id: branchIdSchema }),
  output: agentActivitySchema,
  async execute(ctx: CodeReviewContext, { id }) {
    return readActivity(ctx.bb, ctx.store, branchKey(id));
  },
});
