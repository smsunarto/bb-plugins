import { z } from "zod";
import { accountSchema, reviewEventSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { submitReview as postReview } from "../lib/drafts.ts";

/** Posts the viewer's review, with every draft in it, as a comment, approval, or change request. */
export const submitReviewContract = {
  input: z.strictObject({
    account: accountSchema,
    pullRequestId: z.string().min(1),
    headRefOid: z.string().min(1),
    event: reviewEventSchema,
    body: z.string(),
  }),
  output: z.strictObject({ url: z.string().nullable() }),
};

export async function submitReview(
  ctx: CodeReviewContext,
  { account, ...review }: z.output<typeof submitReviewContract.input>,
): Promise<z.input<typeof submitReviewContract.output>> {
  return postReview(ctx.github.as(account), review);
}
