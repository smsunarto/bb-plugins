import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import {
  changeStarredModels,
  starKey,
  t3ComposerContract,
  type StarredModel,
  type StarredModelsChange,
} from "./contract";

// BB's server holds the starred models, so every device shows the same ones. This device keeps
// the last list it saw in localStorage and draws it first, before the server answers.
//
// Stars used to live only in localStorage. A device that still has such a list adds it to the
// server's once, and until that write is acknowledged the device's own list stays on show.

/** Also where the device-only stars were kept, which is how an old list is found. */
const CACHE_KEY = "bb-plugin:t3-composer:model-favorites";
const ADOPTED_KEY = "bb-plugin:t3-composer:model-favorites:synced";
const ADOPT_RETRY_MS = 30_000;
const NO_KEYS: readonly string[] = [];

interface DeviceStars {
  /** `starKey` strings, in star order. */
  keys: readonly string[];
  /** Whether this device's own stars have reached the server. */
  adopted: boolean;
}

const listeners = new Set<() => void>();
let device: DeviceStars | null = null;
let adopting = false;
let adoptRetryAt = 0;

function readDevice(): DeviceStars {
  if (device) return device;
  let keys = NO_KEYS;
  let adopted = false;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]");
    if (Array.isArray(parsed)) keys = parsed.filter((key) => typeof key === "string");
    adopted = localStorage.getItem(ADOPTED_KEY) === "1";
  } catch {
    // Storage can be disabled; the server's list still shows once it loads.
  }
  device = { keys, adopted };
  return device;
}

function writeDevice(next: DeviceStars) {
  device = next;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next.keys));
    if (next.adopted) localStorage.setItem(ADOPTED_KEY, "1");
  } catch {
    // Storage can be full or disabled; the list still applies for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CACHE_KEY && event.key !== ADOPTED_KEY) return;
    device = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const SERVER_SNAPSHOT: DeviceStars = { keys: NO_KEYS, adopted: true };

function parseStarKey(key: string): StarredModel | null {
  const separator = key.indexOf("\u0000");
  if (separator <= 0 || separator === key.length - 1) return null;
  return { providerId: key.slice(0, separator), model: key.slice(separator + 1) };
}

function sameKeys(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export interface StarredModels {
  /** `starKey(providerId, model)` of every starred model. Stable until the stars change. */
  keys: ReadonlySet<string>;
  /** In star order. Stable until the stars change. */
  models: readonly StarredModel[];
  toggle(providerId: string, model: string): void;
  /** Why the stars shown may differ from the server's, or null when they match it. */
  notice: string | null;
}

/**
 * The starred models and the star toggle. `enabled: false` reads nothing from the server and
 * serves this device's last list, for a surface that does not need the stars yet.
 */
export function useStarredModels(options: { enabled?: boolean } = {}): StarredModels {
  const local = useSyncExternalStore(subscribe, readDevice, () => SERVER_SNAPSHOT);
  const query = useRpcQuery({
    contract: t3ComposerContract,
    method: "starredModels",
    input: null,
    enabled: options.enabled ?? true,
  });
  const change = useRpcMutation({
    contract: t3ComposerContract,
    method: "changeStarredModels",
    optimistic(input, cache) {
      cache.update("starredModels", null, (current) =>
        current ? { models: [...changeStarredModels(current.models, input)] } : current,
      );
    },
  });
  const server = query.data?.models;
  const serverKeys = useMemo(
    () => server?.map((entry) => starKey(entry.providerId, entry.model)),
    [server],
  );

  // Once this device's stars are on the server, the server's list is the one it remembers.
  useEffect(() => {
    if (!serverKeys || !local.adopted || sameKeys(serverKeys, local.keys)) return;
    writeDevice({ keys: serverKeys, adopted: true });
  }, [serverKeys, local]);

  // A device that starred models before stars synced adds them to the server's list, once.
  const mutate = change.mutate;
  useEffect(() => {
    if (!serverKeys || local.adopted || adopting || Date.now() < adoptRetryAt) return;
    const known = new Set(serverKeys);
    const own = local.keys.flatMap((key) => (known.has(key) ? [] : (parseStarKey(key) ?? [])));
    if (own.length === 0) {
      writeDevice({ keys: serverKeys, adopted: true });
      return;
    }
    adopting = true;
    mutate({ add: own, remove: [] })
      // The server's answer holds every star, so nothing typed since is lost.
      .then((result) =>
        writeDevice({
          keys: result.models.map((entry) => starKey(entry.providerId, entry.model)),
          adopted: true,
        }),
      )
      .catch(() => {
        adoptRetryAt = Date.now() + ADOPT_RETRY_MS;
      })
      .finally(() => {
        adopting = false;
      });
  }, [serverKeys, local, mutate]);

  // Until adoption, this device's own stars show beside the server's.
  const shown = useMemo(() => {
    if (!serverKeys) return local.keys;
    if (local.adopted) return serverKeys;
    const known = new Set(serverKeys);
    return [...serverKeys, ...local.keys.filter((key) => !known.has(key))];
  }, [serverKeys, local]);

  // Keyed on the list alone, so a re-render with the same stars hands back the same values.
  const stars = useMemo(
    () => ({ keys: new Set(shown), models: shown.flatMap((key) => parseStarKey(key) ?? []) }),
    [shown],
  );

  return {
    keys: stars.keys,
    models: stars.models,
    toggle(providerId, model) {
      const entry = { providerId, model };
      const input: StarredModelsChange = stars.keys.has(starKey(providerId, model))
        ? { add: [], remove: [entry] }
        : { add: [entry], remove: [] };
      const current = readDevice();
      // Before adoption the device's list is still its own, so the change lands there too.
      if (!current.adopted) {
        const next = changeStarredModels(
          current.keys.flatMap((key) => parseStarKey(key) ?? []),
          input,
        );
        writeDevice({
          keys: next.map((star) => starKey(star.providerId, star.model)),
          adopted: false,
        });
      }
      // A failed write rolls its prediction back and shows through `notice`.
      mutate({ add: [...input.add], remove: [...input.remove] }).catch(() => undefined);
    },
    notice: change.error
      ? `Could not save that star: ${change.error.message}`
      : query.error && !serverKeys
        ? "Showing this device's stars. BB could not be reached."
        : null,
  };
}

/** For tests: forget what this page has read from localStorage. */
export function resetStarredModelsForTest() {
  device = null;
  adopting = false;
  adoptRetryAt = 0;
}
