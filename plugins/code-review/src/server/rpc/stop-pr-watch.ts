import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { prRefSchema } from "../../shared/schema.ts";
import type { CodeReviewContext } from "../lib/context.ts";

/** Stops a thread's watch of a pull request from its card. The agent is not told. */
export const stopPrWatch = defineMutation({
  input: z.strictObject({ threadId: z.string().min(1), ref: prRefSchema }),
  output: z.strictObject({ stopped: z.boolean() }),
  async execute(ctx: CodeReviewContext, { threadId, ref }) {
    return { stopped: await ctx.watcher.stop(threadId, ref) };
  },
});
