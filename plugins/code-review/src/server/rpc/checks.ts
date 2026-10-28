import { z } from "zod";
import { accountSchema, checksSchema, prRefSchema } from "../../shared/schema.ts";
import { loadChecks } from "../lib/checks.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Check runs and commit statuses on the head commit: failures first, then running ones. */
export const checksContract = {
  input: z.strictObject({ account: accountSchema, ref: prRefSchema }),
  output: checksSchema,
};

export async function checks(
  ctx: CodeReviewContext,
  { account, ref }: z.output<typeof checksContract.input>,
): Promise<z.input<typeof checksContract.output>> {
  return loadChecks(ctx.github.as(account), ref);
}
