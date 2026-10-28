import { z } from "zod";
import { accountSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { deleteDraft as removeDraft } from "../lib/drafts.ts";

/** Deletes a draft comment from the pending review. */
export const deleteDraftContract = {
  input: z.strictObject({ account: accountSchema, commentId: z.string().min(1) }),
  output: z.strictObject({ ok: z.literal(true) }),
};

export async function deleteDraft(
  ctx: CodeReviewContext,
  { account, commentId }: z.output<typeof deleteDraftContract.input>,
): Promise<z.input<typeof deleteDraftContract.output>> {
  await removeDraft(ctx.github.as(account), commentId);
  return { ok: true as const };
}
