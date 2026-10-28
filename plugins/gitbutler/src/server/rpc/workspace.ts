import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  repositoryKeySchema,
  workspaceSchema,
  type Workspace,
} from "../../shared/schema.ts";
import { boardFor } from "../lib/board.ts";
import {
  HostOffline,
  hostClient,
  rememberLocation,
  repositoryTarget,
  resolveTarget,
} from "../lib/target.ts";

export const workspaceContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: workspaceSchema,
};

export async function workspace(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey }: z.output<typeof workspaceContract.input>,
): Promise<z.input<typeof workspaceContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
  if (!target) return unavailable("noEnvironment", reason, null);
  try {
    const read = await hostClient(ctx.bb).call(
      "workspace",
      repositoryTarget(target, repositoryKey),
      { hostId: target.hostId },
    );
    // Where the board was read is where its subthread records and its
    // selected checkout's next write look first.
    if (read.repositoryKey !== null && read.checkoutIdentity) {
      const { path, commonDir } = read.checkoutIdentity;
      rememberLocation(ctx.bb, target, repositoryKey, {
        key: read.repositoryKey,
        path,
        commonDir,
      });
    }
    return boardFor(read, target);
  } catch (error) {
    // A laptop that sleeps is a passing state, not a failure. As an `error`
    // answer it keeps the last board on screen, without a retry or a server
    // warning on every poll.
    if (!(error instanceof HostOffline)) throw error;
    return unavailable(
      "error",
      `${error.message} The workspace loads when it reconnects.`,
      target.environmentId,
    );
  }
}

function unavailable(
  state: "noEnvironment" | "error",
  reason: string,
  environmentId: string | null,
): Workspace {
  return {
    state,
    reason,
    environmentId,
    repositoryKey: null,
    repoName: "",
    unassignedChanges: [],
    stacks: [],
    base: null,
    upstream: null,
    conflictedFiles: [],
  };
}
