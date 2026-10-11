import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import type { ReviewContext } from "./start.ts";
export const result = defineCommand({
  summary: "Read only the result belonging to a specific review run",
  positionals: [{ name: "run-id", description: "Review run ID returned by start", required: true }],
  options: {
    wait: { type: "duration", defaultUnit: "s", description: "Bounded wait, at most 60 seconds" },
  },
  async execute(ctx: CommandContext<ReviewContext>, { positionals, options }) {
    if (!ctx.threadId)
      throw new PluginCliError("Run inside the parent or reviewer thread", { code: "no_thread" });
    const waitSeconds = Math.floor((options.wait ?? 0) / 1000);
    if (waitSeconds > 60)
      throw new PluginCliError("Wait must be at most 60 seconds", { code: "invalid_wait" });
    const value = await ctx.reviews.result(
      ctx.threadId,
      { runId: positionals["run-id"], waitSeconds },
      ctx.signal ?? new AbortController().signal,
    );
    return { exitCode: 0, stdout: JSON.stringify(value) + "\n" };
  },
});
