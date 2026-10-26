import type { Board, CanvasNode, Freshness, Workspace } from "../../shared/schema.ts";
import { hasOutput } from "../../shared/canvas-plan.ts";
import { nodeTakes } from "../../shared/takes.ts";
import { inputFingerprint } from "./canvas-generation.ts";

/**
 * Whether each node's output was made from what the node says now. A pick made by a run whose
 * recorded inputs match is fresh; one made from an older brief or older inputs is stale. An
 * upload, a hand-written note, or an output whose run is not on record cannot be judged.
 */
export function boardFreshness(
  board: Board,
  workspace: Pick<Workspace, "documents" | "assets" | "generationJobs">,
): Record<string, Freshness> {
  const jobs = new Map(workspace.generationJobs.map((job) => [job.id, job]));
  const compare = (node: CanvasNode, jobId: string | undefined): Freshness => {
    const inputs = jobId ? jobs.get(jobId)?.target?.inputs : undefined;
    if (!inputs) return "unknown";
    return inputs === inputFingerprint(node, board, workspace) ? "fresh" : "stale";
  };
  return Object.fromEntries(
    board.nodes.map((node): [string, Freshness] => {
      if (!hasOutput(node)) return [node.id, "missing"];
      if (node.type === "document" || node.type === "table") return [node.id, "fresh"];
      if (node.type === "text") {
        const jobId = node.data.generationJobId;
        // A note someone typed is its own source.
        if (typeof jobId !== "string") return [node.id, "fresh"];
        return [node.id, compare(node, jobId)];
      }
      const pick = node.data.assetId;
      if (!workspace.assets.some((asset) => asset.id === pick)) return [node.id, "unknown"];
      const take = nodeTakes(node).find((take) => take.assetId === pick);
      return [node.id, compare(node, take?.jobId || undefined)];
    }),
  );
}
