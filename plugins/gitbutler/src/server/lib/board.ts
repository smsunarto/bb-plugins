import type { HostWorkspace, Workspace } from "../../shared/schema.ts";
import { nativeAgentPrompts } from "./prompts.ts";
import type { Target } from "./target.ts";

/**
 * A host's answer as the panel draws it: with the environment it was read
 * in, which says which signals are about it. A board also names the machine
 * it was read on and, for a plain Git checkout, the prompts its native
 * agents take.
 */
export function boardFor(read: HostWorkspace, target: Target): Workspace {
  if (read.state !== "ready") return { ...read, environmentId: target.environmentId };
  return {
    ...read,
    environmentId: target.environmentId,
    hostId: target.hostId,
    nativeAgentPrompts:
      read.checkoutIdentity.kind === "git"
        ? nativeAgentPrompts(read.checkoutIdentity, target.hostId)
        : null,
  };
}
