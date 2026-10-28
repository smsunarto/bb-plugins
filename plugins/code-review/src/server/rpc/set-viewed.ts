import { z } from "zod";
import { accountSchema, viewedStateSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { setViewed as markViewed } from "../lib/drafts.ts";

/** Marks a file viewed or unviewed for the viewer, as github.com's "Viewed" box does. */
export const setViewedContract = {
  input: z.strictObject({
    account: accountSchema,
    pullRequestId: z.string().min(1),
    path: z.string().min(1),
    viewed: z.boolean(),
  }),
  output: z.strictObject({ viewed: viewedStateSchema }),
};

export async function setViewed(
  ctx: CodeReviewContext,
  { account, ...input }: z.output<typeof setViewedContract.input>,
): Promise<z.input<typeof setViewedContract.output>> {
  return { viewed: await markViewed(ctx.github.as(account), input) };
}
