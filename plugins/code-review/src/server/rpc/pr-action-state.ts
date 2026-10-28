import { z } from "zod";
import { accountSchema, prRefSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadPrActionState, prActionStateSchema } from "../lib/pr-actions.ts";

export const prActionStateContract = {
  input: z.strictObject({ account: accountSchema, ref: prRefSchema }),
  output: prActionStateSchema,
};

export async function prActionState(
  ctx: CodeReviewContext,
  { account, ref }: z.output<typeof prActionStateContract.input>,
): Promise<z.input<typeof prActionStateContract.output>> {
  return loadPrActionState(ctx.github.as(account), ref);
}
