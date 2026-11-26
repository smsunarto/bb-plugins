// The sidebar's Captain entry points read the Captain plugin, which may be
// absent or disabled. Nothing asks Captain anything until bb's plugin list
// says it runs, so a sidebar without it makes no failing calls and draws no
// Captain controls. One shared cache per SDK client serves both navigation and
// the thread list so they make one `/api/v1/plugins` read and always agree.
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

export type CaptainAvailability = "loading" | "available" | "unavailable";

interface CaptainAvailabilityStore {
  status: CaptainAvailability;
  started: boolean;
  listeners: Set<() => void>;
}

const availabilityStores = new WeakMap<object, CaptainAvailabilityStore>();

function getAvailabilityStore(sdk: ReturnType<typeof useSdk>): CaptainAvailabilityStore {
  let store = availabilityStores.get(sdk);
  if (store === undefined) {
    store = { status: "loading", started: false, listeners: new Set() };
    availabilityStores.set(sdk, store);
  }
  return store;
}

function startAvailabilityRead(
  sdk: ReturnType<typeof useSdk>,
  store: CaptainAvailabilityStore,
): void {
  if (store.started) return;
  store.started = true;
  const setStatus = (next: CaptainAvailability) => {
    if (store.status === next) return;
    store.status = next;
    for (const listener of store.listeners) listener();
  };
  void sdk.plugins.list().then(
    ({ plugins }) =>
      setStatus(
        plugins.some(
          (plugin) =>
            plugin.id === CAPTAIN_PLUGIN_ID && plugin.enabled && SERVING.has(plugin.status),
        )
          ? "available"
          : "unavailable",
      ),
    () => setStatus("unavailable"),
  );
}

/**
 * Shared Captain plugin availability for this SDK client: `"loading"` on first
 * mount, then `"available"` or `"unavailable"` once one `sdk.plugins.list()`
 * call settles. Cached per SDK client so navigation and the thread list share
 * one read, stay in sync, and do not re-fetch or pop in on remounts.
 */
export function useCaptainAvailability(): CaptainAvailability {
  const sdk = useSdk();
  const store = getAvailabilityStore(sdk);
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener);
      startAvailabilityRead(sdk, store);
      return () => {
        store.listeners.delete(listener);
      };
    },
    [sdk, store],
  );
  const getSnapshot = useCallback(() => store.status, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether Captain is installed, enabled and serving, from the shared per-client
 * read of bb's plugin list. False until the list answers, and on any failure.
 */
export function useCaptainAvailable(): boolean {
  return useCaptainAvailability() === "available";
}

export interface CaptainRoster {
  /** Whether the Captain plugin is confirmed running and serving RPCs. */
  available: boolean;
  /**
   * Whether Captain shelf/project separation is active: true during first paint
   * (from synchronous thread origin) and while Captain runs; false once bb
   * confirms Captain is absent or disabled.
   */
  shelfActive: boolean;
  /** Live Captain thread ids; synchronous on first paint, refined by RPC. */
  captainIds: ReadonlySet<string>;
  /** Each listed Captain's Needs you count, by thread id; empty when unavailable. */
  needsYou: Readonly<Record<string, number>>;
}

/**
 * Live Captain thread ids and each listed Captain's Needs you count:
 * - Synchronous first paint identifies Captain threads from `isLongLivedThread`
 *   so no frame flashes Captains inside a project folder.
 * - Once `sdk.plugins.list()` confirms Captain runs, one shared `captains` RPC
 *   refines the roster and one batched `needsYou` RPC reads their counts.
 * - If `captains` RPC fails or is still loading while Captain runs, the
 *   synchronous roster holds so Captains never drop back into a project folder.
 * - Once bb confirms Captain is absent or disabled, everything clears and no
 *   Captain RPCs run.
 */
export function useCaptainRoster(threads: readonly PluginSidebarThread[]): CaptainRoster {
  const availability = useCaptainAvailability();
  const available = availability === "available";
  const shelfActive = availability !== "unavailable";
  const captains = useRpcQuery({
    contract: captainContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "captains",
    input: NO_INPUT,
    enabled: available,
  });
  const rpcIds = captains.data?.ids;
  // Synchronous fallback from thread metadata while loading or if the RPC fails.
  const joinedSyncIds = useMemo(
    () =>
      shelfActive
        ? threads
            .filter((thread) => isLongLivedThread(thread))
            .map((thread) => thread.id)
            .join(",")
        : "",
    [shelfActive, threads],
  );
  // Joined, so an unchanged Captain roster keeps the same Set identity.
  const joinedIds = useMemo(() => {
    if (!shelfActive) return "";
    if (available && rpcIds !== undefined) return rpcIds.join(",");
    return joinedSyncIds;
  }, [shelfActive, available, rpcIds, joinedSyncIds]);
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
  return useMemo(
    () => ({ available, shelfActive, captainIds, needsYou }),
    [available, shelfActive, captainIds, needsYou],
  );
}
