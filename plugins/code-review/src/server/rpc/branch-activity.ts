import { z } from "zod";
import { agentActivitySchema, branchIdSchema, branchKey } from "../../shared/schema.ts";
import { agentActivity as readActivity } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** The bb reviews started for an unpublished branch, and the findings to show. */
export const branchActivityContract = {
  input: z.strictObject({ id: branchIdSchema }),
  output: agentActivitySchema,
};

export async function branchActivity(
  ctx: CodeReviewContext,
  { id }: z.output<typeof branchActivityContract.input>,
): Promise<z.input<typeof branchActivityContract.output>> {
  return readActivity(ctx.bb, ctx.store, branchKey(id));
}
