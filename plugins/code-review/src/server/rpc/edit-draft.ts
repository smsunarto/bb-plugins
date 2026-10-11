import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { editDraft as rewriteDraft } from "../lib/drafts.ts";

/** Rewrites a draft comment's body. */
export const editDraft = defineMutation({
  input: z.strictObject({
    account: accountSchema,
    commentId: z.string().min(1),
    body: z.string().regex(/\S/, "Write a comment first."),
  }),
  output: z.strictObject({ ok: z.literal(true) }),
  async execute(ctx: CodeReviewContext, { account, commentId, body }) {
    await rewriteDraft(ctx.github.as(account), commentId, body);
    return { ok: true as const };
  },
});
