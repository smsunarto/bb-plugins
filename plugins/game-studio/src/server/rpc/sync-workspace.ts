import { defineQuery } from "@bb-kit/core/rpc";
import { syncedWorkspace, syncWorkspaceInput } from "../../shared/canvas-contract.ts";
import {
  readWorkspace,
  workspaceFingerprint,
  type WorkspaceContext,
} from "../lib/workspace-read.ts";

/**
 * The open studio's read. It keeps the canvas watched, and a studio that
 * already has this workspace gets back only its fingerprint.
 */
export const syncWorkspace = defineQuery({
  input: syncWorkspaceInput,
  output: syncedWorkspace,
  description: "Read a game workspace for an open studio, unless it already has this version.",
  async execute(ctx: WorkspaceContext, { gameId, since }) {
    const workspace = await readWorkspace(ctx, gameId, { watch: true });
    const fingerprint = workspaceFingerprint(workspace);
    return since === fingerprint
      ? { status: "unchanged" as const, fingerprint }
      : { status: "changed" as const, fingerprint, workspace };
  },
});
