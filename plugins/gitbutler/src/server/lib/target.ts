import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The panel is always scoped to one thread's environment. Resolution fails
 * for ordinary, explainable reasons — a thread with no project, an
 * environment still starting — so it returns a reason instead of throwing.
 */
export type Target = { hostId: string; environmentPath: string };
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
    target: { hostId: environment.hostId, environmentPath: environment.path },
    reason: null,
  };
}
