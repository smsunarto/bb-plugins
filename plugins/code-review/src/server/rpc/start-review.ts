import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { accountSchema, prKey, prRefSchema } from "../../shared/schema.ts";
import { linkThread, runningReview } from "../lib/activity.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { createLocks } from "../lib/lock.ts";
import { requireProject, reviewEnvironment } from "../lib/projects.ts";
import { reviewPrompt } from "../lib/prompts.ts";
import { loadPrHead } from "../lib/pull-request.ts";

/*
 * Finding no running review, starting one, and linking it happen under the
 * pull request's lock. Otherwise a double click, or two windows, would each
 * find none and start two reviews of one commit.
 */
const withLock = createLocks();

/**
 * Starts a thread on bb's default agent that reviews the pull request's head commit and
 * reports its findings with `code_review_report_findings`. Asking again
 * while a review of the same commit and base runs returns that review.
 */
export const startReview = defineMutation({
  input: z.strictObject({ account: accountSchema, ref: prRefSchema }),
  output: z.strictObject({ threadId: z.string() }),
  async execute(ctx: CodeReviewContext, { account, ref }) {
    const pr = await loadPrHead(ctx.github.as(account), ref);
    return withLock(prKey(ref).toLowerCase(), async () => {
      const running = await runningReview(ctx.bb, ctx.store, prKey(ref), pr);
      if (running) return { threadId: running };

      const project = await requireProject(ctx.bb, ref.owner, ref.repo);
      const { environment, reused } = await reviewEnvironment(ctx.bb, project, pr);
      const thread = await ctx.bb.sdk.threads.spawn({
        projectId: project.id,
        environment,
        reasoningLevel: "high",
        visibility: "visible",
        title: `Review ${prKey(ref)}`,
        pluginMetadata: { kind: "review", pr: prKey(ref), headRefOid: pr.headRefOid },
        prompt: reviewPrompt(pr, { reused, instructions: await ctx.store.instructions() }),
      });
      await linkThread(ctx.bb, ctx.store, prKey(ref), {
        threadId: thread.id,
        kind: "review",
        headRefOid: pr.headRefOid,
        baseRefName: pr.baseRefName,
      });
      return { threadId: thread.id };
    });
  },
});
