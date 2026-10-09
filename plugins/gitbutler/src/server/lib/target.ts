import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The panel is always scoped to one thread's environment. Resolution fails
 * for ordinary, explainable reasons — a thread with no project, an
 * environment still starting — so it returns a reason instead of throwing.
 */
export type Target = { hostId: string; environmentPath: string; environmentId: string };
export type TargetResult = { target: Target; reason: null } | { target: null; reason: string };

export async function resolveTarget(bb: BbPluginApi, threadId: string): Promise<TargetResult> {
  const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
  const environment = "environment" in thread ? thread.environment : undefined;
  if (!environment) {
    return { target: null, reason: "This thread has no project environment." };
  }
  if (!environment.path) {
    return { target: null, reason: "This thread's environment has no workspace path yet." };
  }
  if (environment.status !== "ready") {
    return { target: null, reason: `This thread's environment is ${environment.status}.` };
  }
  return {
    target: {
      hostId: environment.hostId,
      environmentPath: environment.path,
      environmentId: environment.id,
    },
    reason: null,
  };
}

export const MOVED =
  "This thread moved to another environment since the board was read. Refresh and try again.";

/**
 * The target of a write the reader aimed at a board read in `environmentId`.
 * A branch or a conflict means nothing outside the environment it was read
 * in, so a thread that has moved to another since is refused. Without an
 * environment, as for a read, any target goes.
 */
export async function writeTarget(
  bb: BbPluginApi,
  threadId: string,
  environmentId: string | undefined,
): Promise<Target> {
  const { target, reason } = await resolveTarget(bb, threadId);
  if (!target) throw new Error(reason);
  if (environmentId && environmentId !== target.environmentId) {
    throw new Error(MOVED);
  }
  return target;
}
