import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { prRefSchema, pullRequestSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadPullRequest } from "../lib/pull-request.ts";

/** One pull request: header, reviewers, timeline, review threads with drafts, and stack. */
export const pullRequest = defineQuery({
  input: z.strictObject({ ref: prRefSchema }),
  output: pullRequestSchema,
  async execute(ctx: CodeReviewContext, { ref }) {
    return loadPullRequest(ctx.gh, ref);
  },
});
