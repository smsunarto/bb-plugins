import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import type { ReviewContext } from "./start.ts";
export const context = defineCommand({
  summary: "Read bounded immutable context for a review run",
  positionals: [{ name: "run-id", description: "Review run ID", required: true }],
  options: {
    section: {
      type: "enum",
      values: ["brief", "evidence", "diff", "tree", "file", "report"],
      default: "brief",
      description: "Context to retrieve progressively",
    },
    path: { type: "string", description: "Repository-relative file path for section=file" },
    side: {
      type: "enum",
      values: ["base", "head"],
      default: "head",
      description: "Pinned source side",
    },
    offset: {
      type: "integer",
      min: 0,
      max: 100000000,
      default: 0,
      description: "Character offset from the preceding page",
    },
  },
  async execute(ctx: CommandContext<ReviewContext>, { positionals, options }) {
    if (!ctx.threadId)
      throw new PluginCliError("Run inside the parent or reviewer thread", { code: "no_thread" });
    const value = await ctx.reviews.context(
      ctx.threadId,
      {
        runId: positionals["run-id"],
        section: options.section,
        path: options.path,
        side: options.side,
        offset: options.offset,
      },
      ctx.signal ?? new AbortController().signal,
    );
    return { exitCode: 0, stdout: JSON.stringify(value) + "\n" };
  },
});
