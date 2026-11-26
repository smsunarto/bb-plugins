// Captain integration for the sidebar.
//
// Shelf membership does not depend on Captain plugin availability: Captain-origin
// threads (`isLongLivedThread`) always land on the Captains shelf from first paint,
// refined by Captain's `captains` RPC once it answers. Plugin availability gates
// only the New Captain navigation row and Captain RPCs (`captains`, `homeProjects`,
// `needsYou`). One shared per-client cache serves both navigation and the inbox,
// retrying transient failures or `"starting"` up to a deadline and re-reading on
// `plugins-changed` and realtime reconnects without polling.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
  useSdk,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { CAPTAIN_PLUGIN_ID, captainContract } from "../lib/captain-contract";
import { isLongLivedThread } from "../lib/long-lived";

const NO_INPUT = {};
const NO_KEYS: string[] = [];
const NO_IDS: ReadonlySet<string> = new Set();
const NO_COUNTS: Readonly<Record<string, number>> = {};
/** Statuses in which Captain's server answers its RPCs. */
const SERVING = new Set(["running", "degraded"]);
/** Bounded retry backoff for `"starting"` or transient `plugins.list` failures. */
const RETRY_DELAYS_MS = [250, 750, 2000] as const;

export type CaptainAvailability = "loading" | "available" | "unavailable";

type CaptainPluginList = Awaited<ReturnType<ReturnType<typeof useSdk>["plugins"]["list"]>>;
type CaptainPluginStatus = "available" | "starting" | "unavailable";

interface CaptainAvailabilityStore {
  status: CaptainAvailability;
  started: boolean;
  inFlight: boolean;
  dirty: boolean;
  retryIndex: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  unsubscribes: (() => void)[];
  sawNonConnected: boolean;
  listeners: Set<() => void>;
}

const availabilityStores = new WeakMap<object, CaptainAvailabilityStore>();

function classifyPlugins({ plugins }: CaptainPluginList): CaptainPluginStatus {
  const captain = plugins.find((plugin) => plugin.id === CAPTAIN_PLUGIN_ID);
  if (captain === undefined || !captain.enabled) return "unavailable";
  if (SERVING.has(captain.status)) return "available";
  if (captain.status === "starting") return "starting";
  return "unavailable";
}

function getAvailabilityStore(sdk: ReturnType<typeof useSdk>): CaptainAvailabilityStore {
  let store = availabilityStores.get(sdk);
  if (store === undefined) {
    store = {
      status: "loading",
      started: false,
      inFlight: false,
      dirty: false,
      retryIndex: 0,
      retryTimer: null,
      unsubscribes: [],
      sawNonConnected: false,
      listeners: new Set(),
    };
    availabilityStores.set(sdk, store);
  }
  return store;
}

function setStoreStatus(store: CaptainAvailabilityStore, next: CaptainAvailability): void {
  if (store.status === next) return;
  store.status = next;
  for (const listener of store.listeners) listener();
}

function clearRetryTimer(store: CaptainAvailabilityStore): void {
  if (store.retryTimer !== null) {
    clearTimeout(store.retryTimer);
    store.retryTimer = null;
  }
}

function scheduleRetry(sdk: ReturnType<typeof useSdk>, store: CaptainAvailabilityStore): void {
  if (store.listeners.size === 0) return;
  const delay = RETRY_DELAYS_MS[store.retryIndex];
  if (delay === undefined) {
    store.retryIndex = 0;
    setStoreStatus(store, "unavailable");
    return;
  }
  store.retryIndex += 1;
  clearRetryTimer(store);
  store.retryTimer = setTimeout(() => {
    store.retryTimer = null;
    if (store.listeners.size > 0) runAvailabilityRead(sdk, store);
  }, delay);
}

function runAvailabilityRead(
  sdk: ReturnType<typeof useSdk>,
  store: CaptainAvailabilityStore,
): void {
  if (store.inFlight) {
    store.dirty = true;
    return;
  }
  store.started = true;
  store.inFlight = true;
  store.dirty = false;
  clearRetryTimer(store);
  const finish = (outcome: CaptainPluginStatus | "error") => {
    store.inFlight = false;
    if (store.dirty && store.listeners.size > 0) {
      store.dirty = false;
      runAvailabilityRead(sdk, store);
      return;
    }
    if (outcome === "available" || outcome === "unavailable") {
      store.retryIndex = 0;
      setStoreStatus(store, outcome);
      return;
    }
    scheduleRetry(sdk, store);
  };
  void sdk.plugins.list().then(
    (result) => finish(classifyPlugins(result)),
    () => finish("error"),
  );
}

function triggerRefresh(sdk: ReturnType<typeof useSdk>, store: CaptainAvailabilityStore): void {
  store.retryIndex = 0;
  clearRetryTimer(store);
  runAvailabilityRead(sdk, store);
}

function attachSubscriptions(
  sdk: ReturnType<typeof useSdk>,
  store: CaptainAvailabilityStore,
): void {
  if (store.unsubscribes.length > 0 || typeof sdk.subscribe !== "function") return;
  store.unsubscribes.push(
    sdk.subscribe({
      event: "system:changed",
      callback: (event) => {
        if (event.changes.includes("plugins-changed")) triggerRefresh(sdk, store);
      },
    }),
    sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state !== "connected") {
          store.sawNonConnected = true;
          return;
        }
        if (event.reconnected || store.sawNonConnected) {
          store.sawNonConnected = false;
          triggerRefresh(sdk, store);
        }
      },
    }),
  );
}

function detachSubscriptions(store: CaptainAvailabilityStore): void {
  clearRetryTimer(store);
  for (const unsubscribe of store.unsubscribes) unsubscribe();
  store.unsubscribes.length = 0;
  store.sawNonConnected = false;
}

/**
 * Shared Captain plugin availability for this SDK client: `"loading"` while the
 * initial read, `"starting"` state, or bounded retry is in flight; `"available"`
 * when Captain is enabled and serving; `"unavailable"` once absent, disabled, or
 * retries exhaust their deadline. Re-reads on `plugins-changed` and reconnect.
 */
export function useCaptainAvailability(): CaptainAvailability {
  const sdk = useSdk();
  const store = getAvailabilityStore(sdk);
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener);
      attachSubscriptions(sdk, store);
      if (!store.started) runAvailabilityRead(sdk, store);
      return () => {
        store.listeners.delete(listener);
        if (store.listeners.size === 0) detachSubscriptions(store);
      };
    },
    [sdk, store],
  );
  const getSnapshot = useCallback(() => store.status, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether Captain is installed, enabled and serving, from the shared per-client
 * read of bb's plugin list. False while loading and when unavailable.
 */
export function useCaptainAvailable(): boolean {
  return useCaptainAvailability() === "available";
}

/**
 * Projects whose threads in `threads` are exclusively Captain threads. Used as
 * the synchronous first-paint and offline fallback for Captain's home project so
 * a Captain living in a code project leaves that project's folder untouched.
 */
function captainOnlyProjectIds(
  threads: readonly PluginSidebarThread[],
  captainIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const mixed = new Set<string>();
  for (const thread of threads) {
    seen.add(thread.projectId);
    if (!captainIds.has(thread.id)) mixed.add(thread.projectId);
  }
  const only = new Set<string>();
  for (const projectId of seen) {
    if (!mixed.has(projectId)) only.add(projectId);
  }
  return only.size === 0 ? NO_IDS : only;
}

export interface CaptainRoster {
  /** Whether the Captain plugin is confirmed running and serving RPCs. */
  available: boolean;
  /** Captain thread ids: synchronous Captain-origin unioned with `captains` RPC. */
  captainIds: ReadonlySet<string>;
  /** Projects dedicated to Captains: `homeProjects` RPC or Captain-only projects. */
  homeProjectIds: ReadonlySet<string>;
  /** Each listed Captain's Needs you count, by thread id; empty when unavailable. */
  needsYou: Readonly<Record<string, number>>;
}

/**
 * Captain shelf membership, Captain home projects, and Needs-you counts:
 * - Shelf membership is independent of plugin availability: Captain-origin
 *   threads always land on the Captains shelf from first paint, unioned with
 *   Captain's `captains` RPC when that answer exists.
 * - Home projects come from Captain's `homeProjects` RPC when available, with a
 *   synchronous fallback of projects holding nothing but Captain threads.
 * - Needs-you counts batch-read only while Captain is confirmed serving.
 */
export function useCaptainRoster(threads: readonly PluginSidebarThread[]): CaptainRoster {
  const available = useCaptainAvailable();
  const captains = useRpcQuery({
    contract: captainContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "captains",
    input: NO_INPUT,
    enabled: available,
  });
  const homeProjects = useRpcQuery({
    contract: captainContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "homeProjects",
    input: NO_INPUT,
    enabled: available,
  });
  const rpcIds = captains.data?.ids;
  const rpcHomeProjects = homeProjects.data?.projectIds;

  // Joined, so an unchanged Captain roster keeps the same Set identity.
  const joinedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of threads) {
      if (isLongLivedThread(thread)) ids.add(thread.id);
    }
    if (rpcIds !== undefined) {
      for (const id of rpcIds) ids.add(id);
    }
    return [...ids].join(",");
  }, [threads, rpcIds]);
  const captainIds = useMemo<ReadonlySet<string>>(
    () => (joinedIds === "" ? NO_IDS : new Set(joinedIds.split(","))),
    [joinedIds],
  );

  const joinedHomeProjects = useMemo(() => {
    if (rpcHomeProjects !== undefined) return rpcHomeProjects.join(",");
    return [...captainOnlyProjectIds(threads, captainIds)].join(",");
  }, [rpcHomeProjects, threads, captainIds]);
  const homeProjectIds = useMemo<ReadonlySet<string>>(
    () => (joinedHomeProjects === "" ? NO_IDS : new Set(joinedHomeProjects.split(","))),
    [joinedHomeProjects],
  );

  // Only ask `needsYou` for ids Captain's own `captains` RPC listed.
  const joinedNeedsYouKeys = useMemo(() => {
    if (!available || rpcIds === undefined || rpcIds.length === 0) return "";
    const listed = new Set(rpcIds);
    return threads
      .filter((thread) => listed.has(thread.id) && !thread.isArchived)
      .map((thread) => thread.id)
      .join(",");
  }, [available, rpcIds, threads]);
  const keys = useMemo(
    () => (joinedNeedsYouKeys === "" ? NO_KEYS : joinedNeedsYouKeys.split(",")),
    [joinedNeedsYouKeys],
  );
  const counts = useRpcKeyedQuery({
    contract: captainContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "needsYou",
    keys,
    enabled: available && keys.length > 0,
  });
  const needsYou = (available && counts.data) || NO_COUNTS;

  return useMemo(
    () => ({ available, captainIds, homeProjectIds, needsYou }),
    [available, captainIds, homeProjectIds, needsYou],
  );
}
