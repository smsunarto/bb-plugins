// Whether the Magic Compose toggle is on. Per browser, and shared by every open
// compose screen in that browser.

const STORAGE_KEY = "bb-plugin-magic-compose:enabled";
/** The plugin was Auto Dispatch until it was renamed. A toggle left on then is still on. */
const FORMER_STORAGE_KEY = "bb-plugin-auto-dispatch:enabled";

type Listener = () => void;

const listeners = new Set<Listener>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(): boolean {
  try {
    const store = storage();
    if (store?.getItem(FORMER_STORAGE_KEY) === "1") {
      store.setItem(STORAGE_KEY, "1");
      store.removeItem(FORMER_STORAGE_KEY);
    }
    return store?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = read();

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  const next = event.newValue === "1";
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener();
}

export const magicMode = {
  get: (): boolean => enabled,
  set(next: boolean): void {
    if (next === enabled) return;
    enabled = next;
    try {
      if (next) storage()?.setItem(STORAGE_KEY, "1");
      else storage()?.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or a full quota: the toggle still works for this page.
    }
    for (const listener of listeners) listener();
  },
  subscribe(listener: Listener): () => void {
    if (listeners.size === 0) globalThis.addEventListener?.("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) globalThis.removeEventListener?.("storage", onStorage);
    };
  },
};
