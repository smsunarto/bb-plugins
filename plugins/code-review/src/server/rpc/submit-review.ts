import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema, reviewEventSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { submitReview as postReview } from "../lib/drafts.ts";

/** Posts the viewer's review, with every draft in it, as a comment, approval, or change request. */
export const submitReview = defineMutation({
  input: z.strictObject({
    account: accountSchema,
    pullRequestId: z.string().min(1),
    headRefOid: z.string().min(1),
    event: reviewEventSchema,
    body: z.string(),
  }),
  output: z.strictObject({ url: z.string().nullable() }),
  async execute(ctx: CodeReviewContext, { account, ...review }) {
    return postReview(ctx.github.as(account), review);
  },
});
