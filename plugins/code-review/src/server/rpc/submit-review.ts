import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { reviewEventSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { submitReview as postReview } from "../lib/drafts.ts";

/** Posts the viewer's review, with every draft in it, as a comment, approval, or change request. */
export const submitReview = defineMutation({
  input: z.strictObject({
    pullRequestId: z.string().min(1),
    headRefOid: z.string().min(1),
    event: reviewEventSchema,
    body: z.string(),
  }),
  output: z.strictObject({ url: z.string().nullable() }),
  async execute(ctx: CodeReviewContext, review) {
    return postReview(ctx.gh, review);
  },
});
