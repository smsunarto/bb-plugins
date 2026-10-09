import { defineQuery } from "@bb-kit/core/rpc";
import { commentsInputSchema, commentsOutputSchema } from "../../shared/comments.ts";
import { pollComments } from "../comments-store.ts";

export const comments = defineQuery({
  input: commentsInputSchema,
  output: commentsOutputSchema,
  execute: (ctx, { source, knownSha256 }) => pollComments(ctx.bb, source, knownSha256),
});
