import { z } from "zod";
import { inboxSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";
import { loadInboxes } from "../lib/inbox.ts";

/** Open pull requests waiting on each signed-in account, their own, and their pins. */
export const inboxContract = {
  input: z.null(),
  output: inboxSchema,
};

export async function inbox(ctx: CodeReviewContext): Promise<z.input<typeof inboxContract.output>> {
  return loadInboxes(ctx.github, await ctx.store.pins());
}
