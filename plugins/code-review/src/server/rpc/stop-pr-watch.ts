import { z } from "zod";
import { prRefSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Stops a thread's watch of a pull request from its card. The agent is not told. */
export const stopPrWatchContract = {
  input: z.strictObject({ threadId: z.string().min(1), ref: prRefSchema }),
  output: z.strictObject({ stopped: z.boolean() }),
};

export async function stopPrWatch(
  ctx: CodeReviewContext,
  { threadId, ref }: z.output<typeof stopPrWatchContract.input>,
): Promise<z.input<typeof stopPrWatchContract.output>> {
  return { stopped: await ctx.watcher.stop(threadId, ref) };
}
