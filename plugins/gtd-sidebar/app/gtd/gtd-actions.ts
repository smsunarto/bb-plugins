// GTD's verbs as bb thread actions, so they show in every thread menu bb
// draws (row menu, right-click, the compact long-press drawer, the thread
// header) and can be picked as row quick actions.
//
// An action's `item` is pure and bb calls `useData` once for the app, outside
// the list. The mounted list publishes what the actions need (each thread's
// shelf and family, which families can park, and the writes) to this store,
// so a menu anywhere offers exactly what the list would. With no list
// mounted the actions hide; bb's own Archive stays.
import { useSyncExternalStore } from "react";
import {
  experimental_THREAD_ACTION_GROUPS,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import type { ShelfId } from "../../shared/preferences.ts";

export interface GtdListActions {
  /** Where each listed thread draws; a thread missing here is not listed. */
  shelfOf: ReadonlyMap<string, ShelfId>;
  /** The root of each thread's family on its shelf. */
  rootOf: ReadonlyMap<string, string>;
  /** Family roots with no live work, so a snooze can hold. */
  parkableRoots: ReadonlySet<string>;
  /** bb's Archive, then the advance to the next row of the settled thread's shelf. */
  settle(threadId: string): void;
  unsettle(threadId: string): void;
  /** Parks the whole family until tomorrow morning. */
  snooze(rootThreadId: string): void;
  wake(rootThreadId: string): void;
}

let published: GtdListActions | null = null;
const listeners = new Set<() => void>();

export function publishGtdListActions(actions: GtdListActions | null): void {
  if (published === actions) return;
  published = actions;
  for (const listener of listeners) listener();
}

/** Clears only its own publication, so a remount's newer list stays. */
export function forgetGtdListActions(actions: GtdListActions): void {
  if (published === actions) publishGtdListActions(null);
}

export function currentGtdListActions(): GtdListActions | null {
  return published;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readPublished(): GtdListActions | null {
  return published;
}

export function useGtdListActions(): GtdListActions | null {
  return useSyncExternalStore(subscribe, readPublished, readPublished);
}

const ACTIVE_SHELVES: ReadonlySet<ShelfId> = new Set([
  "pinned",
  "nextAction",
  "waiting",
  "slopcop",
]);

export const SNOOZE_TOMORROW_LABEL = "Snooze until tomorrow";

export const settleThreadAction: PluginThreadActionRegistration<GtdListActions | null> = {
  id: "settle",
  title: "Settle",
  icon: "Check",
  group: experimental_THREAD_ACTION_GROUPS.lifecycle,
  order: 0,
  useData: useGtdListActions,
  item: ({ thread, data }) => {
    const shelf = data?.shelfOf.get(thread.id);
    if (!data || shelf === undefined || !ACTIVE_SHELVES.has(shelf) || thread.archivedAt !== null) {
      return null;
    }
    return { label: "Settle", icon: "Check", run: () => data.settle(thread.id) };
  },
};

export const unsettleThreadAction: PluginThreadActionRegistration<GtdListActions | null> = {
  id: "unsettle",
  title: "Un-settle",
  icon: "ArrowTurnBackward",
  group: experimental_THREAD_ACTION_GROUPS.lifecycle,
  order: 0,
  useData: useGtdListActions,
  item: ({ thread, data }) => {
    if (!data || data.shelfOf.get(thread.id) !== "settled" || thread.archivedAt === null) {
      return null;
    }
    return {
      label: "Un-settle",
      icon: "ArrowTurnBackward",
      run: () => data.unsettle(thread.id),
    };
  },
};

export const snoozeThreadAction: PluginThreadActionRegistration<GtdListActions | null> = {
  id: "snooze",
  title: SNOOZE_TOMORROW_LABEL,
  icon: "Clock",
  group: experimental_THREAD_ACTION_GROUPS.lifecycle,
  order: 1,
  useData: useGtdListActions,
  item: ({ thread, data }) => {
    const shelf = data?.shelfOf.get(thread.id);
    const rootId = data?.rootOf.get(thread.id);
    if (
      !data ||
      shelf === undefined ||
      rootId === undefined ||
      !ACTIVE_SHELVES.has(shelf) ||
      thread.archivedAt !== null ||
      !data.parkableRoots.has(rootId)
    ) {
      return null;
    }
    return {
      label: SNOOZE_TOMORROW_LABEL,
      ...(rootId === thread.id ? {} : { detail: "Snoozes the whole family" }),
      icon: "Clock",
      run: () => data.snooze(rootId),
    };
  },
};

export const wakeThreadAction: PluginThreadActionRegistration<GtdListActions | null> = {
  id: "wake",
  title: "Wake now",
  icon: "BellDot",
  group: experimental_THREAD_ACTION_GROUPS.lifecycle,
  order: 1,
  useData: useGtdListActions,
  item: ({ thread, data }) => {
    const rootId = data?.rootOf.get(thread.id);
    if (!data || rootId === undefined || data.shelfOf.get(thread.id) !== "snoozed") return null;
    return { label: "Wake now", icon: "BellDot", run: () => data.wake(rootId) };
  },
};

export const GTD_THREAD_ACTIONS = [
  settleThreadAction,
  unsettleThreadAction,
  snoozeThreadAction,
  wakeThreadAction,
] as const;
