import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  repositoryKeySchema,
  workspaceSchema,
  type Workspace,
} from "../../shared/schema.ts";
import { HostOffline, hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";
import { nativeAgentPrompts } from "../lib/prompts.ts";

export const workspace = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: workspaceSchema,
  async execute(ctx, { threadId, checkout, repositoryKey }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
    if (!target) return unavailable("noEnvironment", reason, null);
    try {
      const read = await hostClient(ctx.bb).call(
        "workspace",
        repositoryTarget(target, repositoryKey),
        { hostId: target.hostId },
      );
      return {
        ...read,
        environmentId: target.environmentId,
        ...(read.checkoutIdentity?.kind === "git"
          ? { nativeAgentPrompts: nativeAgentPrompts(read.checkoutIdentity, target.hostId) }
          : {}),
      };
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
