// Captain integration for the sidebar.
//
// Shelf membership does not depend on Captain plugin availability: Captain-origin
// threads (`isLongLivedThread`) always land on the Captains shelf from first paint,
// unioned with Captain's `captains` RPC ids when that answer exists (the RPC only
// adds, never removes). Availability gates only the New Captain navigation row and
// Captain RPCs, via one per-SDK cached read raced against `AbortSignal.timeout`
// and refreshed on `plugins-changed` and real realtime reconnects.
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
const AVAILABILITY_TIMEOUT_MS = 5_000;

interface CaptainAvailabilityCache {
  available: boolean;
  pending: Promise<void> | null;
  unsubscribes: (() => void)[];
  sawReconnect: boolean;
  listeners: Set<() => void>;
}

const availabilityCaches = new WeakMap<object, CaptainAvailabilityCache>();
const subscribedCaches = new Set<CaptainAvailabilityCache>();

function getAvailabilityCache(sdk: ReturnType<typeof useSdk>): CaptainAvailabilityCache {
  let cache = availabilityCaches.get(sdk);
  if (cache === undefined) {
    cache = {
      available: false,
      pending: null,
      unsubscribes: [],
      sawReconnect: false,
      listeners: new Set(),
    };
    availabilityCaches.set(sdk, cache);
  }
  return cache;
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
        return undefined;
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
        return undefined;
      },
    );
  });
}

function refreshAvailability(
  sdk: ReturnType<typeof useSdk>,
  cache: CaptainAvailabilityCache,
): void {
  const request = raceWithTimeout(sdk.plugins.list(), AVAILABILITY_TIMEOUT_MS)
    .then(
      ({ plugins }) =>
        plugins.some(
          (plugin) =>
            plugin.id === CAPTAIN_PLUGIN_ID && plugin.enabled && SERVING.has(plugin.status),
        ),
      () => false,
    )
    .then((next) => {
      if (cache.pending === request && cache.available !== next) {
        cache.available = next;
        for (const listener of cache.listeners) listener();
      }
      return undefined;
    });
  cache.pending = request;
}

function detachSubscriptions(cache: CaptainAvailabilityCache): void {
  for (const unsubscribe of cache.unsubscribes) unsubscribe();
  cache.unsubscribes.length = 0;
  cache.sawReconnect = false;
  subscribedCaches.delete(cache);
}

function ensureSubscribed(sdk: ReturnType<typeof useSdk>, cache: CaptainAvailabilityCache): void {
  if (cache.unsubscribes.length > 0 || typeof sdk.subscribe !== "function") return;
  cache.unsubscribes.push(
    sdk.subscribe({
      event: "system:changed",
      callback: (event) => {
        if (event.changes.includes("plugins-changed")) refreshAvailability(sdk, cache);
      },
    }),
    sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "disconnected" || (event.state === "connecting" && event.reconnected)) {
          cache.sawReconnect = true;
          return;
        }
        if (event.state === "connected" && (event.reconnected || cache.sawReconnect)) {
          cache.sawReconnect = false;
          refreshAvailability(sdk, cache);
        }
      },
    }),
  );
  subscribedCaches.add(cache);
}

/**
 * Unsubscribes every active Captain availability listener on bundle teardown or
 * plugin disable so reloads never stack duplicate listeners.
 */
export function disposeCaptainAvailability(): void {
  for (const cache of subscribedCaches) {
    detachSubscriptions(cache);
    cache.pending = null;
  }
}

/**
 * Whether Captain is installed, enabled and serving, from one cached per-SDK
 * read of bb's plugin list raced against a timeout. Re-reads on `plugins-changed`
 * and on a real reconnect; a failed or timed-out read leaves it false until the
 * next event.
 */
export function useCaptainAvailable(): boolean {
  const sdk = useSdk();
  const cache = getAvailabilityCache(sdk);
  const subscribe = useCallback(
    (listener: () => void) => {
      cache.listeners.add(listener);
      ensureSubscribed(sdk, cache);
      if (cache.pending === null) refreshAvailability(sdk, cache);
      return () => {
        cache.listeners.delete(listener);
        if (cache.listeners.size === 0) detachSubscriptions(cache);
      };
    },
    [sdk, cache],
  );
  const getSnapshot = useCallback(() => cache.available, [cache]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface CaptainRoster {
  /** Whether the Captain plugin is confirmed running and serving RPCs. */
  available: boolean;
  /** Captain thread ids: Captain-origin threads unioned with `captains` RPC ids. */
  captainIds: ReadonlySet<string>;
  /** Each listed Captain's Needs you count, by thread id; empty when unavailable. */
  needsYou: Readonly<Record<string, number>>;
}

/**
 * Captain shelf membership and Needs-you counts:
 * - Shelf membership is independent of plugin availability: Captain-origin
 *   threads always land on the Captains shelf from first paint, unioned with
 *   Captain's `captains` RPC ids when that answer exists (the RPC only adds).
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
  const rpcIds = captains.data?.ids;

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

  return useMemo(() => ({ available, captainIds, needsYou }), [available, captainIds, needsYou]);
}
