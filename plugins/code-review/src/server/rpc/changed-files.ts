import { z } from "zod";
import { accountSchema, changedFilesSchema, prRefSchema } from "../../shared/schema.ts";
import { loadChangedFiles } from "../lib/changed-files.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Every changed file's patch and the viewer's "viewed" mark on it. */
export const changedFilesContract = {
  input: z.strictObject({ account: accountSchema, ref: prRefSchema }),
  output: changedFilesSchema,
};

export async function changedFiles(
  ctx: CodeReviewContext,
  { account, ref }: z.output<typeof changedFilesContract.input>,
): Promise<z.input<typeof changedFilesContract.output>> {
  return loadChangedFiles(ctx.github.as(account), ref, account);
}
