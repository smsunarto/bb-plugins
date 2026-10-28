import { z } from "zod";
import { accountSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { editDraft as rewriteDraft } from "../lib/drafts.ts";

/** Rewrites a draft comment's body. */
export const editDraftContract = {
  input: z.strictObject({
    account: accountSchema,
    commentId: z.string().min(1),
    body: z.string().regex(/\S/, "Write a comment first."),
  }),
  output: z.strictObject({ ok: z.literal(true) }),
};

export async function editDraft(
  ctx: CodeReviewContext,
  { account, commentId, body }: z.output<typeof editDraftContract.input>,
): Promise<z.input<typeof editDraftContract.output>> {
  await rewriteDraft(ctx.github.as(account), commentId, body);
  return { ok: true as const };
}
