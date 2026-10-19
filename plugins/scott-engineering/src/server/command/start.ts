import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/rpc";
import { startSchema } from "../../shared/arena.ts";
import type { ArenaService } from "../lib/service.ts";

export type ArenaContext = Context<{ arena: ArenaService }>;
export const start = defineCommand({
  summary: "Launch a background Arena run",
  options: {
    task: {
      type: "string",
      required: true,
      description: "The identical task given to both candidates",
    },
    "request-id": {
      type: "string",
      required: true,
      description: "Stable request identity; reuse when retrying the same launch",
    },
  },
  async execute(ctx: CommandContext<ArenaContext>, { options }) {
    if (!ctx.threadId) throw new Error("Run this command inside the launching BB thread");
    const run = await ctx.arena.start(
      ctx.threadId,
      startSchema.parse({ task: options.task, requestId: options["request-id"] }),
    );
    return {
      exitCode: 0,
      stdout:
        JSON.stringify({ runId: run.id, phase: run.phase, embed: `::arena{run="${run.id}"}` }) +
        "\n",
    };
  },
});
