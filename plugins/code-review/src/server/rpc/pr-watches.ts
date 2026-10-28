import { z } from "zod";
import { prWatchesSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** The pull requests a thread's agent watches, as the latest read found them. */
export const prWatchesContract = {
  input: z.strictObject({ threadId: z.string().min(1) }),
  output: prWatchesSchema,
};

export async function prWatches(
  ctx: CodeReviewContext,
  { threadId }: z.output<typeof prWatchesContract.input>,
): Promise<z.input<typeof prWatchesContract.output>> {
  return { watches: await ctx.watcher.list(threadId) };
}
