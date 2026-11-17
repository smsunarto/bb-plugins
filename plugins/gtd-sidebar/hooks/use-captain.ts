// The sidebar's Captain entry points read the Captain plugin, which may be
// absent or disabled. Nothing asks Captain anything until bb's plugin list
// says it runs, so a sidebar without it makes no failing calls and draws no
// Captain controls.
import { useEffect, useMemo, useState } from "react";
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
  useSdk,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { CAPTAIN_PLUGIN_ID, captainContract } from "../lib/captain-contract";

const NO_INPUT = {};
const NO_KEYS: string[] = [];
const NO_COUNTS: Readonly<Record<string, number>> = {};
/** Statuses in which Captain's server answers its RPCs. */
const SERVING = new Set(["running", "degraded"]);

/**
 * Whether Captain is installed, enabled and serving, from one read of bb's
 * plugin list per mount. False until the list answers, and on any failure.
 */
export function useCaptainAvailable(): boolean {
  const sdk = useSdk();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      try {
        const { plugins } = await sdk.plugins.list({ signal: controller.signal });
        setAvailable(
          plugins.some(
            (plugin) =>
              plugin.id === CAPTAIN_PLUGIN_ID && plugin.enabled && SERVING.has(plugin.status),
          ),
        );
      } catch {
        setAvailable(false);
      }
    };
    void read();
    return () => controller.abort();
  }, [sdk]);
  return available;
}

/**
 * Each listed Captain's Needs you count, by thread id: one shared read of
 * Captain's ids, then one keyed read over the Captain rows the list holds, so
 * every row's count arrives in one batch. A row refreshes when its Captain's
 * banner reads do, through their tags; nothing polls. Empty while Captain is
 * unavailable.
 */
export function useNeedsYouCounts(
  available: boolean,
  threads: readonly PluginSidebarThread[],
): Readonly<Record<string, number>> {
  const captains = useRpcQuery({
    contract: captainContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "captains",
    input: NO_INPUT,
    enabled: available,
  });
  const ids = captains.data?.ids;
  // Joined, so a new roster with the same Captain rows keeps the same keys.
  const joined = useMemo(() => {
    if (ids === undefined || ids.length === 0) return "";
    const live = new Set(ids);
    return threads
      .filter((thread) => live.has(thread.id) && !thread.isArchived)
      .map((thread) => thread.id)
      .join(",");
  }, [ids, threads]);
  const keys = useMemo(() => (joined === "" ? NO_KEYS : joined.split(",")), [joined]);
  const counts = useRpcKeyedQuery({
    contract: captainContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "needsYou",
    keys,
    enabled: available && keys.length > 0,
  });
  return (available && counts.data) || NO_COUNTS;
}
