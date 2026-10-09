import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { viewedStateSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { setViewed as markViewed } from "../lib/drafts.ts";

/** Marks a file viewed or unviewed for the viewer, as github.com's "Viewed" box does. */
export const setViewed = defineMutation({
  input: z.strictObject({
    pullRequestId: z.string().min(1),
    path: z.string().min(1),
    viewed: z.boolean(),
  }),
  output: z.strictObject({ viewed: viewedStateSchema }),
  async execute(ctx: CodeReviewContext, input) {
    return { viewed: await markViewed(ctx.gh, input) };
  },
});
