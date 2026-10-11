import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { agentActivitySchema, prKey, prRefSchema } from "../../shared/schema.ts";
import { agentActivity as readActivity } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** The bb threads started for the pull request, and the bb review to show. */
export const agentActivity = defineQuery({
  input: z.strictObject({ ref: prRefSchema }),
  output: agentActivitySchema,
  async execute(ctx: CodeReviewContext, { ref }) {
    return readActivity(ctx.bb, ctx.store, prKey(ref));
  },
});
