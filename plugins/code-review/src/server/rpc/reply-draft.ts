import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";
import { replyDraft as writeReply } from "../lib/drafts.ts";

/** A draft reply to a review thread, held in the viewer's pending review. */
export const replyDraft = defineMutation({
  input: z.strictObject({
    pullRequestId: z.string().min(1),
    threadId: z.string().min(1),
    body: z.string().regex(/\S/, "Write a reply first."),
  }),
  output: z.strictObject({ commentId: z.string() }),
  async execute(ctx: CodeReviewContext, reply) {
    return writeReply(ctx.gh, reply);
  },
});
