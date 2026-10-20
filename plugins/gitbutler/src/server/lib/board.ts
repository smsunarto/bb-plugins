import type { HostWorkspace, Workspace } from "../../shared/schema.ts";
import { nativeAgentPrompts } from "./prompts.ts";
import type { Target } from "./target.ts";

/**
 * A host's board as the panel draws it: with the environment and machine it
 * was read in, which say which signals are about it, and, for a plain Git
 * checkout, the prompts its native agents take.
 */
export function boardFor(read: HostWorkspace, target: Target): Workspace {
  return {
    ...read,
    environmentId: target.environmentId,
    hostId: target.hostId,
    ...(read.checkoutIdentity?.kind === "git"
      ? { nativeAgentPrompts: nativeAgentPrompts(read.checkoutIdentity, target.hostId) }
      : {}),
  };
}
