import { defineMutation } from "@bb-kit/core/rpc";
import { commentInputSchema, commentOutputSchema } from "../../shared/comments.ts";
import { applyCommentOp } from "../comments-store.ts";

export const comment = defineMutation({
  input: commentInputSchema,
  output: commentOutputSchema,
  execute(ctx, { source, op }) {
    return applyCommentOp(ctx.bb, source, op);
  },
});
