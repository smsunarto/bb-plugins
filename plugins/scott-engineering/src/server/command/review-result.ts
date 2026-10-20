import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import type { ReviewContext } from "./review-start.ts";
export const reviewResult = defineCommand({
  summary: "Read a reviewer thread's native BB status and output",
  positionals: [
    { name: "thread-id", description: "Reviewer thread ID returned by start", required: true },
  ],
  options: {
    offset: {
      type: "integer",
      min: 0,
      max: 100000000,
      default: 0,
      description: "Continue a large output at nextOffset",
    },
  },
  async execute(ctx: CommandContext<ReviewContext>, { positionals, options }) {
    if (!ctx.threadId)
      throw new PluginCliError("Run inside the parent or reviewer thread", { code: "no_thread" });
    const value = await ctx.reviews.result(
      ctx.threadId,
      { threadId: positionals["thread-id"], offset: options.offset },
      ctx.signal ?? new AbortController().signal,
    );
    return { exitCode: 0, stdout: JSON.stringify(value) + "\n" };
  },
});
