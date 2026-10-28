import type { PluginAgentConfigurationContext, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountSchema, parsePrReference, prKey } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { files } from "../lib/instructions.ts";
import { reopenLanded } from "../lib/landed.ts";
import { ownsPullRequests } from "../lib/review-scope.ts";

const parameters = z.strictObject({
  reference: z.string().min(1),
  account: accountSchema.optional(),
  stop: z.boolean().optional(),
});

/** Authors get the tool; answering reviewers leave watching to their parent. */
export function watchPrEnabled(session: PluginAgentConfigurationContext): boolean {
  return ownsPullRequests(session);
}

/** Wakes the calling thread with what changes on a pull request, and shows its checks above the composer. */
export function watchPr(ctx: CodeReviewContext) {
  return {
    name: "code_review_watch_pr",
    ...files.tool("code_review_watch_pr"),
    presentation: {
      label: { pending: "Updating pull request watch", completed: "Updated pull request watch" },
    },
    parameters,
    async execute(
      { reference, account, stop }: z.output<typeof parameters>,
      { threadId }: PluginAgentToolContext,
    ) {
      const ref = parsePrReference(reference);
      if (!ref) throw new Error("Use a GitHub pull request URL or owner/repo#123.");
      if (!stop) {
        const watching = await ctx.watcher.watch(threadId, ref, account);
        // An open pull request means the thread's work has not all landed.
        await reopenLanded(ctx, threadId, ref);
        return watching;
      }
      return (await ctx.watcher.stop(threadId, ref))
        ? `Stopped watching ${prKey(ref)}.`
        : `This thread was not watching ${prKey(ref)}.`;
    },
  };
}
