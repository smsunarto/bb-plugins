import { z } from "zod";
import { accountSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { replyDraft as writeReply } from "../lib/drafts.ts";

/** A draft reply to a review thread, held in the viewer's pending review. */
export const replyDraftContract = {
  input: z.strictObject({
    account: accountSchema,
    pullRequestId: z.string().min(1),
    threadId: z.string().min(1),
    body: z.string().regex(/\S/, "Write a reply first."),
  }),
  // The pending review after the write: a first reply starts one.
  output: z.strictObject({
    commentId: z.string(),
    pendingReview: z.strictObject({ id: z.string(), draftCount: z.number().int().nonnegative() }),
  }),
};

export async function replyDraft(
  ctx: CodeReviewContext,
  { account, ...reply }: z.output<typeof replyDraftContract.input>,
): Promise<z.input<typeof replyDraftContract.output>> {
  return writeReply(ctx.github.as(account), reply);
}
