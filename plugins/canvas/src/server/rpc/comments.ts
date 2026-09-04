import { defineQuery } from "@bb-kit/core/rpc";
import {
  commentsInputSchema,
  commentsOutputSchema,
  type CommentsOutput,
} from "../../shared/comments.ts";
import { readComments } from "../comments-store.ts";

export const comments = defineQuery({
  input: commentsInputSchema,
  output: commentsOutputSchema,
  async execute(ctx, { source, knownSha256 }): Promise<CommentsOutput> {
    const read = await readComments(ctx.bb, source);
    if (knownSha256 !== null && knownSha256 === read.sha256) {
      return { status: "unchanged", sha256: read.sha256 };
    }
    return { status: "loaded", sha256: read.sha256, file: read.file, malformed: read.malformed };
  },
});
