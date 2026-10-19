import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { ArenaContext } from "./start.ts";

export const status = defineCommand({
  summary: "Read an Arena run and its candidate/synthesis summaries",
  options: { run: { type: "string", required: true, description: "Arena run ID" } },
  async execute(ctx: CommandContext<ArenaContext>, { options }) {
    if (!ctx.threadId) throw new Error("Run this command inside the launching BB thread");
    return {
      exitCode: 0,
      stdout: JSON.stringify(await ctx.arena.owner(options.run, ctx.threadId)) + "\n",
    };
  },
});
