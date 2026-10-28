import type { PluginAgentConfigurationContext, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MAX_LANDED,
  landedDirective,
  notLanded,
  parseCommitReference,
  sameCommit,
} from "../../shared/landed.ts";
import { accountSchema, parsePrReference, sameRef } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { GhError } from "../lib/gh.ts";
import { files } from "../lib/instructions.ts";
import { checkLanded, readLanded } from "../lib/landed.ts";
import { ownsPullRequests } from "../lib/review-scope.ts";

const parameters = z.strictObject({
  pullRequests: z.array(z.string().min(1)).max(MAX_LANDED).optional(),
  commits: z.array(z.string().min(1)).max(MAX_LANDED).optional(),
  account: accountSchema.optional(),
});

/** Authors land their work; answering reviewers never merge. */
export function shareLandedEnabled(session: PluginAgentConfigurationContext): boolean {
  return ownsPullRequests(session);
}

/**
 * Checks what the thread landed on GitHub, marks its title with 🚀 while all
 * of it has, and returns the card that settles the thread.
 */
export function shareLanded(ctx: CodeReviewContext) {
  return {
    name: "code_review_share_landed",
    ...files.tool("code_review_share_landed"),
    presentation: {
      label: { pending: "Checking landed work", completed: "Checked landed work" },
    },
    parameters,
    async execute(
      { pullRequests = [], commits = [], account }: z.output<typeof parameters>,
      { threadId }: PluginAgentToolContext,
    ) {
      const prs = pullRequests.map((reference) => {
        const ref = parsePrReference(reference);
        if (!ref) throw new Error(`${reference}: use a GitHub pull request URL or owner/repo#123.`);
        return ref;
      });
      const commitRefs = commits.map((reference) => {
        const ref = parseCommitReference(reference);
        if (!ref) throw new Error(`${reference}: use owner/repo@<sha> or a GitHub commit URL.`);
        return ref;
      });
      if (prs.length + commitRefs.length === 0) {
        throw new Error("List the pull requests and default-branch commits this thread delivered.");
      }
      const login = account ?? (await ctx.github.accounts())[0];
      if (!login)
        throw new GhError("unauthenticated", "GitHub CLI is not signed in. Run `gh auth login`.");
      const target = {
        account: login,
        prs: prs.filter((ref, i) => prs.findIndex((other) => sameRef(other, ref)) === i),
        commits: commitRefs.filter(
          (ref, i) => commitRefs.findIndex((other) => sameCommit(other, ref)) === i,
        ),
      };
      // Read before anything is written: work that has not landed at all leaves the title alone.
      const read = await readLanded(ctx.github.as(login), target);
      const unlanded = notLanded(read);
      if (unlanded.length === target.prs.length + target.commits.length) {
        throw new Error(
          `Nothing listed has landed yet: ${unlanded.join(", ")}. Call again once a pull request merges or the commits reach the default branch.`,
        );
      }
      const { landed, pending, title } = await checkLanded(ctx, threadId, target, read);
      const directive = landedDirective({
        account: login,
        prs: landed.prs.map((pr) => pr.ref),
        commits: landed.commits.map((commit) => commit.ref),
      });
      const note =
        pending.length === 0
          ? title === undefined
            ? "Everything listed has landed, but the thread title could not be updated."
            : "Everything listed has landed; the thread title starts with 🚀."
          : `Not landed yet: ${pending.join(", ")}. The title gets 🚀 once all of it lands.`;
      return `${directive}\n\n${note}`;
    },
  };
}
