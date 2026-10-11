import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { deleteDraft as removeDraft } from "../lib/drafts.ts";

/** Deletes a draft comment from the pending review. */
export const deleteDraft = defineMutation({
  input: z.strictObject({ account: accountSchema, commentId: z.string().min(1) }),
  output: z.strictObject({ ok: z.literal(true) }),
  async execute(ctx: CodeReviewContext, { account, commentId }) {
    await removeDraft(ctx.github.as(account), commentId);
    return { ok: true as const };
  },
});
