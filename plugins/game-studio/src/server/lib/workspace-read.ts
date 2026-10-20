import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Workspace } from "../../shared/schema.ts";
import type { Generations } from "./generations.ts";
import { loadCanvas } from "./studio.ts";

export type WorkspaceContext = { bb: BbPluginApi; generations?: Generations };

function uncertain(workspace: Workspace): Workspace {
  return {
    ...workspace,
    generationJobs: workspace.generationJobs.map((job) =>
      ["queued", "running"].includes(job.status)
        ? {
            ...job,
            status: "uncertain" as const,
            detail: "Could not refresh generation status. Check the saved job before resuming.",
          }
        : job,
    ),
  };
}

/**
 * The workspace a studio shows: one host read, with canvas jobs refreshed.
 * A refresh that adopts outputs writes the board, so it reads once more to
 * show them.
 */
export async function readWorkspace(
  ctx: WorkspaceContext,
  gameId: string,
  options: { watch?: boolean } = {},
): Promise<Workspace> {
  let read = await loadCanvas(ctx.bb, gameId, options);
  if (!ctx.generations) return read.workspace;
  for (let pass = 0; ; pass++) {
    if (read.stale) return uncertain(read.workspace);
    let refreshed;
    try {
      refreshed = await ctx.generations.refresh(read.workspace.game, read);
    } catch {
      return uncertain(read.workspace);
    }
    if (!refreshed.changed || pass > 0)
      return { ...read.workspace, generationJobs: refreshed.jobs };
    read = await loadCanvas(ctx.bb, gameId, options);
  }
}

/** Equal for equal workspaces, so a studio that has one is told it is unchanged. */
export function workspaceFingerprint(workspace: Workspace): string {
  return createHash("sha256").update(JSON.stringify(workspace)).digest("hex");
}
