import { defineQuery } from "@bb-kit/core/rpc";
import { gameInput, workspaceSchema } from "../../shared/schema.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Generations } from "../lib/generations.ts";
import { loadWorkspace } from "../lib/studio.ts";

export const get = defineQuery({
  input: gameInput,
  output: workspaceSchema,
  async execute(ctx: { bb: BbPluginApi; generations?: Generations }, input) {
    let jobs;
    let refreshFailed = false;
    if (ctx.generations) {
      try {
        jobs = await ctx.generations.list(input.gameId);
      } catch {
        refreshFailed = true;
      }
    }
    const workspace = await loadWorkspace(ctx.bb, input.gameId);
    if (jobs) workspace.generationJobs = jobs;
    else if (refreshFailed) {
      workspace.generationJobs = workspace.generationJobs.map((job) =>
        ["queued", "running"].includes(job.status)
          ? {
              ...job,
              status: "uncertain" as const,
              detail: "Could not refresh generation status. Check the saved job before resuming.",
            }
          : job,
      );
    }
    return workspace;
  },
});
