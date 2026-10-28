import { z } from "zod";
import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { accountSchema, parsePrReference, prKey } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalBranches, rememberBranch } from "../lib/gitbutler.ts";
import { files } from "../lib/instructions.ts";

const parameters = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("branch"),
      branch: z.string().min(1),
      hostId: z.string().optional(),
      path: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal("pr"),
      reference: z.string().min(1),
      account: accountSchema.optional(),
    }),
  ]),
});

/** Resolves an agent's branch name into the identity the Review panel uses. */
export function shareChanges(ctx: CodeReviewContext) {
  return {
    name: "code_review_share_changes",
    ...files.tool("code_review_share_changes"),
    parameters,
    async execute(
      { target }: z.output<typeof parameters>,
      { threadId, signal }: PluginAgentToolContext,
    ) {
      if (target.kind === "pr") {
        const ref = parsePrReference(target.reference);
        if (!ref) throw new Error("Use a GitHub pull request URL or owner/repo#123.");
        return `::code-review{pr="${prKey(ref)}"${target.account ? ` account="${target.account}"` : ""}}`;
      }
      let scope: { hostId: string; path?: string };
      if (target.hostId) {
        scope = { hostId: target.hostId, ...(target.path ? { path: target.path } : {}) };
      } else {
        const thread = await ctx.bb.sdk.threads.get({ threadId, include: "environment" });
        const environment = "environment" in thread ? thread.environment : null;
        if (!environment?.path || environment.status !== "ready") {
          throw new Error(
            "This thread has no ready checkout. Supply hostId and path to share a branch from another checkout.",
          );
        }
        scope = { hostId: environment.hostId, path: target.path ?? environment.path };
      }
      const result = await loadLocalBranches(ctx.bb, signal, scope);
      if (!result.available) throw new Error(result.reason);
      const matches = result.branches.filter(
        (branch) =>
          (branch.branch === target.branch || branch.id === target.branch) &&
          scope.hostId === branch.hostId,
      );
      const branch = matches[0];
      if (!branch)
        throw new Error(
          "No unpublished branch matches. If it has a pull request, pass the PR instead. Otherwise commit the changes on the task's GitButler branch first.",
        );
      if (matches.length !== 1)
        throw new Error(
          `Several checkouts match; specify hostId and path: ${matches.map(({ hostId, path }) => `${hostId}:${path}`).join(", ")}`,
        );
      await rememberBranch(ctx.bb, ctx.store, branch);
      return `::code-review{branch="${branch.id}" base="${branch.base}" head="${branch.head}"}`;
    },
  };
}
