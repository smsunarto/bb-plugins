import { z } from "zod";
import { accountSchema, pinSchema, prRefSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Pins or unpins a pull request in the inbox, as `account`. Returns the pins in order. */
export const setPinnedContract = {
  input: z.strictObject({ account: accountSchema, ref: prRefSchema, pinned: z.boolean() }),
  output: z.strictObject({ pinned: z.array(pinSchema) }),
};

export async function setPinned(
  ctx: CodeReviewContext,
  { account, ref, pinned }: z.output<typeof setPinnedContract.input>,
): Promise<z.input<typeof setPinnedContract.output>> {
  return { pinned: await ctx.store.setPinned(ref, pinned, account) };
}
