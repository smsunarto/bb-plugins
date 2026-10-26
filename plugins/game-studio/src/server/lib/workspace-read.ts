import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PendingRun, Workspace } from "../../shared/schema.ts";
import type { Generations } from "./generations.ts";
import { loadCanvas } from "./studio.ts";

export type WorkspaceContext = { bb: BbPluginApi; generations?: Generations };

/** The workspace with its runs' status in doubt; held runs are the server's own and stay shown. */
function uncertain(
  workspace: Workspace,
  pending: Record<string, Record<string, PendingRun>>,
): Workspace {
  return {
    ...workspace,
    boards: workspace.boards.map((entry) =>
      Object.assign({}, entry, { pending: pending[entry.board.id] ?? {} }),
    ),
    generationJobs: workspace.generationJobs.map((job) =>
      ["queued", "running"].includes(job.status)
        ? Object.assign({}, job, {
            status: "uncertain" as const,
            detail: "Could not refresh generation status. Check the saved job before resuming.",
          })
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
    if (read.stale) return uncertain(read.workspace, ctx.generations.pending(gameId));
    let refreshed;
    try {
      refreshed = await ctx.generations.refresh(read.workspace.game, read);
    } catch {
      return uncertain(read.workspace, ctx.generations.pending(gameId));
    }
    if (!refreshed.changed || pass > 0)
      return {
        ...read.workspace,
        generationJobs: refreshed.jobs,
        boards: read.workspace.boards.map((entry) =>
          Object.assign({}, entry, { pending: refreshed.pending[entry.board.id] ?? {} }),
        ),
      };
    read = await loadCanvas(ctx.bb, gameId, options);
  }
}

/** Equal for equal workspaces, so a studio that has one is told it is unchanged. */
export function workspaceFingerprint(workspace: Workspace): string {
  return createHash("sha256").update(JSON.stringify(workspace)).digest("hex");
}
