/**
 * Asks each connected machine's host entry to run, or stop, the shared
 * Agentation server: at load, when a host connects, when its worker exits
 * unexpectedly, and when the setting changes. Hosts are asked one by one
 * without waiting on each other, so a slow or sleeping machine delays only
 * itself. While the setting has never been on, nothing here contacts a host.
 * A sync before the service starts does nothing, since the factory cannot
 * call hosts yet; the service's first sync covers it.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { agentationHostContract } from "./local-server-contract.ts";

const ENSURE_TIMEOUT_MS = 20_000;

export function wireLocalServer(
  bb: BbPluginApi,
  enabled: () => Promise<boolean>,
): { sync(): Promise<void>; dispose(): void } {
  const host = bb.hosts.experimental_client({ contract: agentationHostContract });
  let disposed = false;

  async function ensureOn(hostId: string): Promise<void> {
    if (disposed) return;
    try {
      const want = await enabled();
      const result = await host.call(
        "ensureLocalServer",
        { enabled: want },
        { hostId, timeoutMs: ENSURE_TIMEOUT_MS },
      );
      if (result.state === "running" || result.state === "stopped") return;
      const message = result.message ? `: ${result.message}` : "";
      bb.log.warn(`agentation server on ${hostId} is ${result.state}${message}`);
    } catch (error) {
      if (disposed) return;
      bb.log.warn(
        `agentation server on ${hostId} not ensured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function ensureAll(): Promise<void> {
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    for (const each of hosts) {
      if (each.status === "connected" && each.lifecycle.phase === "active") void ensureOn(each.id);
    }
  }

  let unwatch: (() => void) | null = null;
  let started = false;

  /** Follow host connections and worker exits while the server should run. */
  function watch(): void {
    if (unwatch) return;
    const unsubscribe = bb.sdk.subscribe({
      event: "host:changed",
      callback: (event) => {
        if (event.id && event.changes.includes("host-connected")) void ensureOn(event.id);
      },
    });
    const stopWatchingExits = host.experimental_onWorkerExit(({ hostId }) => void ensureOn(hostId));
    unwatch = () => {
      unsubscribe();
      stopWatchingExits();
    };
  }

  /** Apply the setting: start and follow hosts when on; stop them once when turned off. */
  async function sync(): Promise<void> {
    if (!started) return;
    const want = await enabled().catch(() => false);
    if (disposed) return;
    if (want) watch();
    else if (!unwatch) return;
    await ensureAll();
    if (!want) {
      unwatch?.();
      unwatch = null;
    }
  }

  // Host calls are refused while the factory registers, so the first sync
  // runs as a service, which starts after the load commits and stops on
  // reload, disable, and shutdown.
  bb.background.service("local-server", {
    async start(signal) {
      disposed = false;
      started = true;
      await sync();
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      dispose();
    },
  });

  function dispose(): void {
    disposed = true;
    unwatch?.();
    unwatch = null;
  }

  return { sync, dispose };
}
