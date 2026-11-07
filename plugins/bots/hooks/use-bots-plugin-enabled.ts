import { useEffect, useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { BOTS_PLUGIN_ID } from "../contract";

type PluginsArea = ReturnType<typeof useSdk>["plugins"];

/** States in which the Bots server answers RPC. */
const SERVING = new Set(["running", "degraded", "starting"]);
/** A focus or visibility change rechecks at most this often. */
const RECHECK_MS = 30_000;

let enabled: boolean | undefined;
let checkedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function check(plugins: PluginsArea | undefined, force = false) {
  if (inFlight || (!force && Date.now() - checkedAt < RECHECK_MS)) return;
  // A host without the plugins area (a test harness) cannot have Bots.
  if (plugins === undefined) return;
  inFlight = plugins
    .list()
    .then(({ plugins: installed }) => {
      const bots = installed.find((plugin) => plugin.id === BOTS_PLUGIN_ID);
      const next = bots !== undefined && bots.enabled && SERVING.has(bots.status);
      checkedAt = Date.now();
      if (next === enabled) return;
      enabled = next;
      for (const listener of listeners) listener();
    })
    // An unreachable server keeps the last answer; the next focus retries.
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the Bots plugin is installed, enabled, and serving, for surfaces
 * outside it (GTD Sidebar's Bots shelf). `undefined` until the first answer.
 * Every caller shares one plugin-list read, refreshed when the window regains
 * focus or visibility, so enabling Bots shows its shelf without a reload.
 */
export function useBotsPluginEnabled(): boolean | undefined {
  const { plugins } = useSdk();
  useEffect(() => {
    check(plugins, enabled === undefined);
    const recheck = () => {
      if (document.visibilityState === "visible") check(plugins);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [plugins]);
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => undefined,
  );
}
