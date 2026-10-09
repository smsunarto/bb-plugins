import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";
import { discardReview as deleteReview } from "../lib/drafts.ts";

/** Deletes the viewer's pending review and every draft in it. */
export const discardReview = defineMutation({
  input: z.strictObject({ pullRequestId: z.string().min(1) }),
  output: z.strictObject({ ok: z.literal(true) }),
  async execute(ctx: CodeReviewContext, { pullRequestId }) {
    await deleteReview(ctx.gh, pullRequestId);
    return { ok: true as const };
  },
});
