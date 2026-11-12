import { useEffect, useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { BOTS_PLUGIN_ID } from "../contract";

type Sdk = ReturnType<typeof useSdk>;
type PluginsArea = Sdk["plugins"];

/** States in which the Bots server answers RPC. */
const SERVING = new Set(["running", "degraded", "starting"]);
/** A focus or visibility change rechecks at most this often. */
const RECHECK_MS = 30_000;

let enabled: boolean | undefined;
let checkedAt = 0;
let inFlight: Promise<void> | null = null;
/** A forced check arrived mid-read, whose answer may predate the change. */
let rerun: PluginsArea | null = null;
const listeners = new Set<() => void>();

function check(plugins: PluginsArea | undefined, force = false) {
  if (inFlight) {
    if (force && plugins !== undefined) rerun = plugins;
    return;
  }
  if (!force && Date.now() - checkedAt < RECHECK_MS) return;
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
      const next = rerun;
      rerun = null;
      if (next !== null) check(next, true);
    });
}

let watchers = 0;
let unwatch: (() => void) | null = null;

/**
 * One shared realtime subscription for every caller: bb announces each
 * install, enable, disable, and removal as `plugins-changed`, and a
 * reconnect may have missed one.
 */
function watch(sdk: Sdk) {
  watchers += 1;
  if (watchers === 1) {
    const offChanged = sdk.subscribe({
      event: "system:changed",
      callback: (event) => {
        if (event.changes.includes("plugins-changed")) check(sdk.plugins, true);
      },
    });
    const offConnection = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.reconnected) check(sdk.plugins, true);
      },
    });
    unwatch = () => {
      offChanged();
      offConnection();
    };
  }
  return () => {
    watchers -= 1;
    if (watchers === 0) {
      unwatch?.();
      unwatch = null;
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the Bots plugin is installed, enabled, and serving, for surfaces
 * outside it (GTD Sidebar's Bots shelf). `undefined` until the first answer.
 * Every caller shares one plugin-list read, refreshed when bb reports a
 * plugin change (or the window regains focus), so enabling or disabling Bots
 * shows or hides its surfaces without a reload.
 */
export function useBotsPluginEnabled(): boolean | undefined {
  const sdk = useSdk();
  const { plugins } = sdk;
  useEffect(() => watch(sdk), [sdk]);
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
