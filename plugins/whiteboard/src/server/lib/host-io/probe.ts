import type { HostOutput } from "../../../shared/contracts/host-contract.ts";
import { hostIo } from "./client.ts";

export type HostProbe = HostOutput<"probe">;

const probes = new Map<string, Promise<HostProbe>>();
let lastDiffr: string | null | undefined;

/**
 * What a host offers (git, jj, gh, diffr), probed once per host and plugin
 * load. `info`'s `structuralDiffEnabled` and `whiteboard_status` read it. A
 * failed probe is retried on the next call.
 */
export function probeHost(hostId: string): Promise<HostProbe> {
  let probe = probes.get(hostId);
  if (!probe) {
    probe = hostIo()
      .client.call("probe", {}, { hostId })
      .then((result) => {
        lastDiffr = result.diffr;
        return result;
      });
    probes.set(hostId, probe);
    probe.catch(() => probes.delete(hostId));
  }
  return probe;
}

/** The diffr the most recent probe found: undefined before any probe, null when none was found. */
export function lastProbedDiffr(): string | null | undefined {
  return lastDiffr;
}

/** Forget probes (a host's tools changed, or a worker restarted). */
export function forgetProbes(hostId?: string): void {
  if (hostId === undefined) probes.clear();
  else probes.delete(hostId);
}
