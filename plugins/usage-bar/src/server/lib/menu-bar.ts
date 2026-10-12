import { sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { menuHostContract, menuHostSignals } from "../../shared/host-contract.ts";
import { createMenuState } from "./menu-state.ts";
import { POOL_PLUGIN_ID, createSourceReader } from "./sources.ts";

/** Reading the pool is a local store read; quota itself moves on proxied traffic. */
const POLL_MS = 15_000;
/** The first render on a Mac compiles the helper, which can take a minute. */
const RENDER_TIMEOUT_MS = 5 * 60_000;

/** Unlike `once(signal, "abort")`, this also settles for an already-aborted signal. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Read quota for the lifetime of the background service and push the menu to
 * every connected host. Each Mac's host entry draws it in that Mac's menu bar,
 * so the items appear on the Mac you use even when the bb server runs elsewhere.
 */
export async function runMenuBar(bb: BbPluginApi, signal: AbortSignal): Promise<void> {
  // Dev bb instances auto-install workspace plugins and would each draw duplicate items.
  if (
    bb.server.experimental_dataDir.split(sep).includes(".bb-dev") &&
    process.env.BB_USAGE_BAR_ANY_INSTANCE !== "1"
  ) {
    bb.log.info("usage-bar: dev bb instances do not draw the menu bar; idling.");
    await untilAborted(signal);
    return;
  }

  const client = bb.hosts.experimental_client({
    contract: menuHostContract,
    experimental_signals: menuHostSignals,
  });
  let refreshing = false;
  let hostIds: string[] = [];
  /** Hosts whose entry answered that it cannot draw a menu bar. */
  const unsupported = new Set<string>();
  const problems = new Map<string, string>();
  /** One render in flight per host; a newer menu waits for it, then goes out. */
  const inFlight = new Set<string>();
  const pending = new Set<string>();

  const renderOn = (hostId: string) => {
    if (inFlight.has(hostId)) {
      pending.add(hostId);
      return;
    }
    inFlight.add(hostId);
    void (async () => {
      try {
        const result = await client.call(
          "render",
          { snapshot: state.snapshot(), refreshing },
          { hostId, signal, timeoutMs: RENDER_TIMEOUT_MS },
        );
        if (result.status === "unsupported") unsupported.add(hostId);
        const problem = result.status === "needs-configuration" ? result.message : undefined;
        if (problem !== undefined && problems.get(hostId) !== problem) {
          bb.log.warn(`usage-bar: host ${hostId}: ${problem}`);
          // Other Macs keep drawing, so mark the plugin instead of stopping the service.
          bb.status.needsConfiguration(`Host ${hostId}: ${problem}`);
        }
        if (problem === undefined) problems.delete(hostId);
        else problems.set(hostId, problem);
      } catch (error) {
        if (!signal.aborted)
          bb.log.debug(`usage-bar: render on host ${hostId} failed: ${String(error)}`);
      } finally {
        inFlight.delete(hostId);
        if (pending.delete(hostId) && !signal.aborted) renderOn(hostId);
      }
    })();
  };
  const render = () => {
    for (const hostId of hostIds) if (!unsupported.has(hostId)) renderOn(hostId);
  };
  const listHosts = async () => {
    try {
      const hosts = await bb.sdk.hosts.list({ signal });
      hostIds = hosts.filter((host) => host.status === "connected").map((host) => host.id);
    } catch (error) {
      if (!signal.aborted) bb.log.debug(`usage-bar: listing hosts failed: ${String(error)}`);
    }
  };

  const state = createMenuState(signal, render);
  const readSource = createSourceReader(bb);

  const publish = (refresh = false) => state.publish(() => readSource(signal, refresh), refresh);

  const refreshAll = async () => {
    if (refreshing) return;
    refreshing = true;
    render();
    try {
      if (state.source?.kind === "pool") {
        await Promise.allSettled(
          state.source.providers.flatMap((provider) =>
            provider.accounts
              .filter((account) => account.status !== "disabled")
              .map((account) =>
                bb.sdk.plugins.callRpc({
                  pluginId: POOL_PLUGIN_ID,
                  method: "account.refreshUsage",
                  input: { accountId: account.id },
                  outputSchema: z.unknown(),
                  signal,
                }),
              ),
          ),
        );
      }
    } finally {
      try {
        await publish(true);
      } finally {
        refreshing = false;
        render();
      }
    }
  };

  const stopSignals = client.experimental_onSignal("menu", ({ payload }) => {
    if (payload.type === "refresh") void refreshAll();
    else void publish();
  });
  // A source read that ignores the signal must not keep the service from stopping.
  const stopped = untilAborted(signal);
  try {
    await listHosts();
    await Promise.race([publish(), stopped]);
    while (!signal.aborted) {
      await sleep(POLL_MS, undefined, { signal }).catch(() => {});
      if (signal.aborted) break;
      await listHosts();
      // Unchanged quota publishes nothing, so render here too: a host that just
      // connected or restarted its worker gets the menu, and each host skips
      // redrawing what it already shows.
      render();
      await Promise.race([publish(), stopped]);
    }
  } finally {
    stopSignals();
  }
}
