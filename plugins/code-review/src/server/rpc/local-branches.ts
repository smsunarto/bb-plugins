import { z } from "zod";
import { localBranchesSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadLocalBranches, rememberBranch } from "../lib/gitbutler.ts";

/** GitButler branches with commits and no pull request, on every connected machine. */
export const localBranchesContract = {
  input: z.strictObject({}),
  output: localBranchesSchema,
};

export async function localBranches(
  ctx: CodeReviewContext,
): Promise<z.input<typeof localBranchesContract.output>> {
  const result = await loadLocalBranches(ctx.bb);
  if (result.available)
    await Promise.all(result.branches.map((branch) => rememberBranch(ctx.bb, ctx.store, branch)));
  return result;
}
