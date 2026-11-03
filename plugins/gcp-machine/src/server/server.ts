import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createService } from "./lib/service.ts";
import { status } from "./command/status.ts";
import { wakeContract } from "../shared/wake-contract.ts";
import { createWakeJob } from "./lib/wake-job.ts";
import { wake } from "./command/wake.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const gcp = createService(bb);
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const job = createWakeJob({
    wake: gcp.wake,
    readHost: gcp.readHost,
    signal: lifetime.signal,
    resumeFailure: gcp.resumeFailure,
    seenRequests: gcp.wakeReceipts,
  });
  bb.rpc.register(wakeContract, {
    async getIndicator() {
      const state = job.current();
      const waking = state.kind === "waking" || state.kind === "retrying";
      try {
        const host = await gcp.readHost();
        if (host.status === "connected" && host.lifecycle.phase === "active") return "awake";
        if (host.lifecycle.phase === "resuming" || waking) return "waking";
      } catch {
        /* Unavailable connection information uses the neutral icon. */
      }
      return waking ? "waking" : "offline";
    },
    startWake: ({ requestId, requestedAt }) => job.start(requestId, requestedAt),
    getWake: ({ jobId }) => job.get(jobId),
  });
  bb.cli.register(
    defineCli({
      name: "gcp-machine",
      summary: "CLI for the gcp-machine plugin",
      commands: { status: status(gcp), wake: wake(gcp) },
    }),
  );
  await gcp.register();
}
