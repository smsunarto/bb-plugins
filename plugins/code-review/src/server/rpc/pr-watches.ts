import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { prWatchesSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** The pull requests a thread's agent watches, as the latest read found them. */
export const prWatches = defineQuery({
  input: z.strictObject({ threadId: z.string().min(1) }),
  output: prWatchesSchema,
  async execute(ctx: CodeReviewContext, { threadId }) {
    return { watches: await ctx.watcher.list(threadId) };
  },
});
