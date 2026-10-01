import { Fragment, type ReactNode, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/**
 * Portal registry (design §3.8). Frozen API: imperative surfaces mount React
 * into DOM containers they do not own, and one `<PortalHost/>` per mount
 * renders them inside the plugin tree, so SDK components see host providers.
 */
export interface PortalEntry {
  id: string;
  container: HTMLElement;
  element: ReactNode;
}

export interface Portals {
  /** Add or replace the entry. Returns its removal. */
  mount(entry: PortalEntry): () => void;
  /** Re-render an existing entry with a new element. */
  update(id: string, element: ReactNode): void;
}

/** What `PortalHost` reads. Kept off the frozen `Portals` interface. */
interface PortalStore extends Portals {
  subscribe(listener: () => void): () => void;
  snapshot(): readonly PortalEntry[];
}

const stores = new WeakMap<Portals, PortalStore>();

export function createPortals(): Portals {
  let entries: readonly PortalEntry[] = [];
  // Which mount() call put an entry in its slot; update() carries it over.
  const owners = new WeakMap<PortalEntry, object>();
  const listeners = new Set<() => void>();
  const publish = (next: readonly PortalEntry[]) => {
    entries = next;
    for (const listener of Array.from(listeners)) listener();
  };
  const store: PortalStore = {
    mount(entry) {
      const owner = {};
      owners.set(entry, owner);
      const index = entries.findIndex((item) => item.id === entry.id);
      publish(
        index === -1
          ? [...entries, entry]
          : entries.map((item, at) => (at === index ? entry : item)),
      );
      return () => {
        // A later mount under the same id owns the slot now; leave it alone.
        if (entries.some((item) => owners.get(item) === owner))
          publish(entries.filter((item) => owners.get(item) !== owner));
      };
    },
    update(id, element) {
      const index = entries.findIndex((item) => item.id === id);
      if (index === -1) return;
      const next = { ...entries[index]!, element };
      owners.set(next, owners.get(entries[index]!) ?? {});
      publish(entries.map((item, at) => (at === index ? next : item)));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => entries,
  };
  const portals: Portals = { mount: store.mount, update: store.update };
  stores.set(portals, store);
  return portals;
}

const NO_ENTRIES: readonly PortalEntry[] = [];
const noopSubscribe = () => () => {};

/** Renders every registered entry into its container. One per mount. */
export function PortalHost({ portals }: { portals: Portals }) {
  const store = stores.get(portals);
  const entries = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? (() => NO_ENTRIES),
    store?.snapshot ?? (() => NO_ENTRIES),
  );
  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.id}>{createPortal(entry.element, entry.container, entry.id)}</Fragment>
      ))}
    </>
  );
}
