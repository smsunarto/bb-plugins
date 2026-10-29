import { useSyncExternalStore } from "react";

// Favorites are a per-device picker preference, like T3 Code's per-environment list.
const STORAGE_KEY = "bb-plugin:t3-composer:model-favorites";
const EMPTY: readonly string[] = [];
const listeners = new Set<() => void>();
let snapshot: readonly string[] | null = null;

export function favoriteKey(providerId: string, model: string) {
  return `${providerId}\u0000${model}`;
}

function read(): readonly string[] {
  if (snapshot) return snapshot;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    snapshot = Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : EMPTY;
  } catch {
    snapshot = EMPTY;
  }
  return snapshot;
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useFavoriteModels(): {
  favorites: ReadonlySet<string>;
  toggle(providerId: string, model: string): void;
} {
  const keys = useSyncExternalStore(subscribe, read, () => EMPTY);
  return {
    favorites: new Set(keys),
    toggle(providerId, model) {
      const key = favoriteKey(providerId, model);
      const current = read();
      snapshot = current.includes(key)
        ? current.filter((entry) => entry !== key)
        : [...current, key];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Storage can be full or disabled; the choice still applies for this session.
      }
      for (const listener of listeners) listener();
    },
  };
}
