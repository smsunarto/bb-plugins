import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";
import { editDraft as rewriteDraft } from "../lib/drafts.ts";

/** Rewrites a draft comment's body. */
export const editDraft = defineMutation({
  input: z.strictObject({
    commentId: z.string().min(1),
    body: z.string().regex(/\S/, "Write a comment first."),
  }),
  output: z.strictObject({ ok: z.literal(true) }),
  async execute(ctx: CodeReviewContext, { commentId, body }) {
    await rewriteDraft(ctx.gh, commentId, body);
    return { ok: true as const };
  },
});
