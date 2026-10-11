import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { discardReview as deleteReview } from "../lib/drafts.ts";

/** Deletes the viewer's pending review and every draft in it. */
export const discardReview = defineMutation({
  input: z.strictObject({ account: accountSchema, pullRequestId: z.string().min(1) }),
  output: z.strictObject({ ok: z.literal(true) }),
  async execute(ctx: CodeReviewContext, { account, pullRequestId }) {
    await deleteReview(ctx.github.as(account), pullRequestId);
    return { ok: true as const };
  },
});
