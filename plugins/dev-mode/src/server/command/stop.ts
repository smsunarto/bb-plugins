import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { ArenaContext } from "./start.ts";

export const stop = defineCommand({
  summary: "Stop Arena and its active workers independently of the main chat",
  options: { run: { type: "string", required: true, description: "Arena run ID" } },
  async execute(ctx: CommandContext<ArenaContext>, { options }) {
    if (!ctx.threadId) throw new Error("Run this command inside the launching BB thread");
    return {
      exitCode: 0,
      stdout: JSON.stringify(await ctx.arena.stop(options.run, ctx.threadId)) + "\n",
    };
  },
});
