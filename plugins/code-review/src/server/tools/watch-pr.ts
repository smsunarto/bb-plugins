import { defineTool } from "@bb-kit/core/tools";
import type { ToolContext } from "@bb-kit/core/tools";
import { z } from "zod";
import { accountSchema, parsePrReference, prKey } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { ownsPullRequests } from "../lib/review-scope.ts";

/** Wakes the calling thread with what changes on a pull request, and shows its checks above the composer. */
export const watchPr = defineTool({
  presentation: {
    label: { pending: "Updating pull request watch", completed: "Updated pull request watch" },
  },
  parameters: z.strictObject({
    reference: z.string().min(1),
    account: accountSchema.optional(),
    stop: z.boolean().optional(),
  }),
  enabled: (_ctx, session) => ownsPullRequests(session),
  async execute(ctx: ToolContext<CodeReviewContext>, { reference, account, stop }) {
    const ref = parsePrReference(reference);
    if (!ref) throw new Error("Use a GitHub pull request URL or owner/repo#123.");
    if (!stop) return ctx.watcher.watch(ctx.tool.threadId, ref, account);
    return (await ctx.watcher.stop(ctx.tool.threadId, ref))
      ? `Stopped watching ${prKey(ref)}.`
      : `This thread was not watching ${prKey(ref)}.`;
  },
});
