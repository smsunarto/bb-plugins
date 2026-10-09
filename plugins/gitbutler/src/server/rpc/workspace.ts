import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { repositoryKeySchema, workspaceSchema, type Workspace } from "../../shared/schema.ts";
import { HostOffline, hostClient, resolveTarget } from "../lib/target.ts";

export const workspace = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: workspaceSchema,
  async execute(ctx, { threadId, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) return unavailable("noEnvironment", reason, null);
    try {
      const read = await hostClient(ctx.bb).call(
        "workspace",
        { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
        { hostId: target.hostId },
      );
      return { ...read, environmentId: target.environmentId };
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
  },
});

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
