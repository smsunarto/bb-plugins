import { defineTool } from "@bb-kit/core/tools";
import { z } from "zod";
import { accountSchema, parsePrReference, prKey } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalBranches, rememberBranch } from "../lib/gitbutler.ts";

/** Resolves an agent's branch name into the identity the Review panel uses. */
export const shareChanges = defineTool({
  parameters: z.strictObject({
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
  }),
  async execute(ctx: CodeReviewContext, { target }) {
    if (target.kind === "pr") {
      const ref = parsePrReference(target.reference);
      if (!ref) throw new Error("Use a GitHub pull request URL or owner/repo#123.");
      return `::code-review{pr="${prKey(ref)}"${target.account ? ` account="${target.account}"` : ""}}`;
    }
    const result = await loadLocalBranches(
      ctx.bb,
      undefined,
      target.hostId
        ? { hostId: target.hostId, ...(target.path ? { path: target.path } : {}) }
        : undefined,
    );
    if (!result.available) throw new Error(result.reason);
    const matches = result.branches.filter(
      (branch) =>
        (branch.branch === target.branch || branch.id === target.branch) &&
        (target.hostId === undefined || target.hostId === branch.hostId) &&
        (target.path === undefined || target.path === branch.path),
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
});
