import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";

/** bb lost the machine a call was for, named the way the reader knows it. */
export class HostOffline extends Error {
  constructor(hostName: string) {
    super(`${hostName} is not connected.`);
  }
}

/**
 * The client for this plugin's host entry. The environment usually lives on
 * another machine than the bb server, and bb rejects a call to one it lost
 * with a bare "Host is not connected". Such a failure becomes a HostOffline
 * that names the machine. The lookup runs only once a call has failed, so a
 * poll costs no extra round trip.
 */
export function hostClient(bb: BbPluginApi) {
  const client = bb.hosts.experimental_client({ contract: gitbutlerHostContract });
  const call: typeof client.call = async (method, input, options) => {
    try {
      return await client.call(method, input, options);
    } catch (error) {
      const host = await bb.sdk.hosts.get({ hostId: options.hostId }).catch(() => null);
      throw host?.status === "disconnected" ? new HostOffline(host.name) : error;
    }
  };
  return { call };
}

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
