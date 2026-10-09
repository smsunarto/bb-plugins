import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";
import { deleteDraft as removeDraft } from "../lib/drafts.ts";

/** Deletes a draft comment from the pending review. */
export const deleteDraft = defineMutation({
  input: z.strictObject({ commentId: z.string().min(1) }),
  output: z.strictObject({ ok: z.literal(true) }),
  async execute(ctx: CodeReviewContext, { commentId }) {
    await removeDraft(ctx.gh, commentId);
    return { ok: true as const };
  },
});
