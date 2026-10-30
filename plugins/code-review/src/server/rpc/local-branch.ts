import { z } from "zod";
import { branchIdSchema, localBranchSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** A card refreshes only its checkout. Legacy cards discover their location once. */
export const localBranchContract = {
  input: z.strictObject({ id: branchIdSchema, threadId: z.string().min(1).optional() }),
  output: localBranchSchema,
};

export async function localBranch(
  ctx: CodeReviewContext,
  { id, threadId }: z.output<typeof localBranchContract.input>,
): Promise<z.input<typeof localBranchContract.output>> {
  return ctx.branches.find(id, threadId);
}
