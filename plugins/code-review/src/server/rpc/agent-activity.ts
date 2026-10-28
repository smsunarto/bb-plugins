import { z } from "zod";
import { agentActivitySchema, prKey, prRefSchema } from "../../shared/schema.ts";
import { agentActivity as readActivity } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** The bb threads started for the pull request, and the bb review to show. */
export const agentActivityContract = {
  input: z.strictObject({ ref: prRefSchema }),
  output: agentActivitySchema,
};

export async function agentActivity(
  ctx: CodeReviewContext,
  { ref }: z.output<typeof agentActivityContract.input>,
): Promise<z.input<typeof agentActivityContract.output>> {
  return readActivity(ctx.bb, ctx.store, prKey(ref));
}
