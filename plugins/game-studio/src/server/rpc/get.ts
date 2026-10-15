import { defineQuery } from "@bb-kit/core/rpc";
import { gameInput, workspaceSchema } from "../../shared/schema.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Generations } from "../lib/generations.ts";
import { loadWorkspace } from "../lib/studio.ts";

export const get = defineQuery({
  input: gameInput,
  output: workspaceSchema,
  async execute(ctx: { bb: BbPluginApi; generations?: Generations }, input) {
    const workspace = await loadWorkspace(ctx.bb, input.gameId);
    if (ctx.generations) {
      try {
        workspace.generationJobs = await ctx.generations.list(input.gameId);
      } catch {
        // Keep documents and drafts available when the host's status service is unavailable.
        workspace.generationJobs = workspace.generationJobs.map((job) =>
          ["queued", "running"].includes(job.status)
            ? {
                ...job,
                status: "uncertain" as const,
                detail:
                  "Could not refresh generation status. Check the job in its agent thread before resuming.",
              }
            : job,
        );
      }
    }
    return workspace;
  },
});
