import { z } from "zod";
import { accountSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { discardReview as deleteReview } from "../lib/drafts.ts";

/** Deletes the viewer's pending review and every draft in it. */
export const discardReviewContract = {
  input: z.strictObject({ account: accountSchema, pullRequestId: z.string().min(1) }),
  output: z.strictObject({ ok: z.literal(true) }),
};

export async function discardReview(
  ctx: CodeReviewContext,
  { account, pullRequestId }: z.output<typeof discardReviewContract.input>,
): Promise<z.input<typeof discardReviewContract.output>> {
  await deleteReview(ctx.github.as(account), pullRequestId);
  return { ok: true as const };
}
