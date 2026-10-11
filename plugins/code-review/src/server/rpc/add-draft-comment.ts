import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema, diffSideSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { addDraftComment as writeDraft } from "../lib/drafts.ts";

const line = z.number().int().positive();

/**
 * Starts a draft thread on a line, or on `startLine`..`line`, in the
 * viewer's pending review. Nobody else sees it until the review is submitted.
 * `headRefOid` and `baseRefName` name the diff the line numbers were picked in.
 * The same draft sent again returns the thread it started and writes nothing.
 */
export const addDraftComment = defineMutation({
  input: z
    .strictObject({
      account: accountSchema,
      pullRequestId: z.string().min(1),
      headRefOid: z.string().min(1),
      baseRefName: z.string().min(1),
      path: z.string().min(1),
      body: z.string().regex(/\S/, "Write a comment first."),
      line,
      startLine: line.nullable(),
      side: diffSideSchema,
      startSide: diffSideSchema.nullable(),
    })
    // Line numbers on the base and the head count different files, so only
    // a range on one side can be out of order.
    .refine(
      (draft) =>
        draft.startLine === null ||
        (draft.startSide ?? draft.side) !== draft.side ||
        draft.startLine <= draft.line,
      { message: "A comment's range must start at or before its last line.", path: ["startLine"] },
    ),
  // The pending review after the write, so the reader can submit or discard
  // it without reloading the pull request.
  output: z.strictObject({
    threadId: z.string(),
    commentId: z.string(),
    pendingReview: z.strictObject({ id: z.string(), draftCount: z.number().int().nonnegative() }),
  }),
  async execute(ctx: CodeReviewContext, { account, ...draft }) {
    return writeDraft(ctx.github.as(account), draft);
  },
});
