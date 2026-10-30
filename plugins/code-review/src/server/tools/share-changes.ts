import { z } from "zod";
import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { accountSchema, parsePrReference, prKey } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalBranches, rememberBranch } from "../lib/gitbutler.ts";
import { reviewGroupSchema } from "../../shared/review-group.ts";
import { files } from "../lib/instructions.ts";

const targetSchema = z.discriminatedUnion("kind", [
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
]);
const parameters = z
  .strictObject({
    target: targetSchema.optional(),
    targets: z.array(targetSchema).min(2).max(25).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.target === undefined) === (value.targets === undefined))
      ctx.addIssue({ code: "custom", message: "Supply exactly one of target or targets." });
  });

/** Resolves an agent's branch name into the identity the Review panel uses. */
export function shareChanges(ctx: CodeReviewContext) {
  return {
    name: "code_review_share_changes",
    ...files.tool("code_review_share_changes"),
    parameters,
    async execute(input: z.output<typeof parameters>, agent: PluginAgentToolContext) {
      if (input.targets) {
        const resolved = [];
        // Bounded sequential resolution preserves order and avoids a host discovery burst.
        for (const target of input.targets) {
          try {
            resolved.push(await resolveTarget(ctx, target, agent));
          } catch (error) {
            const label = target.kind === "pr" ? target.reference : target.branch;
            throw new Error(`Could not share ${label}: ${String(error)}`, { cause: error });
          }
        }
        const targets = reviewGroupSchema.parse(resolved);
        return `::code-review{targets="${encodeURIComponent(JSON.stringify(targets))}"}`;
      }
      if (!input.target) throw new Error("Supply a target.");
      const target = await resolveTarget(ctx, input.target, agent);
      return "branch" in target
        ? `::code-review{branch="${target.branch}" base="${target.base}" head="${target.head}"}`
        : `::code-review{pr="${target.pr}"${target.account ? ` account="${target.account}"` : ""}}`;
    },
  };
}

async function resolveTarget(
  ctx: CodeReviewContext,
  target: z.output<typeof targetSchema>,
  { threadId, signal }: PluginAgentToolContext,
) {
  if (target.kind === "pr") {
    const ref = parsePrReference(target.reference);
    if (!ref) throw new Error("Use a GitHub pull request URL or owner/repo#123.");
    return { pr: prKey(ref), ...(target.account ? { account: target.account } : {}) };
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
  return {
    branch: branch.id,
    base: branch.base,
    head: branch.head,
    branchName: branch.branch,
    hostId: branch.hostId,
    path: branch.path,
  };
}
