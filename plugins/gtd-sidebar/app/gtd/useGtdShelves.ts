// The list's data: bb's sidebar threads with GTD's own state folded in
// (hidden worker activity, snoozes, the 24-hour Settled window, the machine
// filter, and the project scope), cut into bb's Pinned section and GTD's
// shelves.
import { useMemo, useRef, useState } from "react";
import { atom, useAtomValue } from "jotai";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useHiddenWorkerActivity } from "../../hooks/use-hidden-worker-activity.ts";
import { useLifecycle, type LifecycleApi } from "../../hooks/use-lifecycle.ts";
import { useMachineVisibility } from "../../hooks/use-machine-visibility.ts";
import { useMinuteClock } from "../../hooks/use-minute-clock.ts";
import { useSettledArchivePaging } from "../../hooks/use-settled-threads.ts";
import { buildInboxTree, createShelfArrivals } from "../../lib/inbox-tree.ts";
import { filterByProject } from "../../lib/inbox.ts";
import { filterHiddenMachines, sidebarMachines, type SidebarMachine } from "../../lib/machines.ts";
import { isShelvedThread } from "../../lib/settled-threads.ts";
import { retainUnchangedThreads } from "../../lib/stable-threads.ts";
import type { SidebarThread } from "../model/sidebar-thread.ts";
import { useSidebarData } from "../model/use-sidebar-data.ts";
import { sidebarOrganizationModeAtom } from "../preferences/atoms.ts";
import { buildShelfLayout, pinnedFamilyIds, type ShelfLayout } from "./shelf-model.ts";

/** The project scope: null for every project. Session state, as it always was. */
export const projectScopeAtom = atom<string | null>(null);

function useStableThreads<T extends { id: string }>(threads: readonly T[]): readonly T[] {
  const previous = useRef<readonly T[]>([]);
  return useMemo(() => {
    previous.current = retainUnchangedThreads(previous.current, threads);
    return previous.current;
  }, [threads]);
}

export interface GtdShelves {
  status: ReturnType<typeof useSidebarData>["status"];
  /** Waits for the snooze and machine reads, so hidden rows never flash. */
  ready: boolean;
  data: ReturnType<typeof useSidebarData>;
  /** bb's roster with worker activity folded in, before any filter. */
  threads: readonly SidebarThread[];
  /** What the list draws: shelved, on a visible machine, in scope. */
  visibleThreads: readonly SidebarThread[];
  pinnedThreads: readonly SidebarThread[];
  layout: ShelfLayout;
  lifecycle: LifecycleApi;
  machines: readonly SidebarMachine[];
  visibility: ReturnType<typeof useMachineVisibility>;
  scope: string | null;
  /** bb's project order, personal project left out. */
  bbProjectOrder: readonly string[];
  /** The order drawn: a pending drop's prediction, else bb's. */
  projectOrder: readonly string[];
}

/**
 * A project drop's predicted order and the bb order it was predicted from. It
 * draws only while bb still publishes an equal order, so bb's republished
 * order replaces it the moment it lands.
 */
export interface ProjectOrderPrediction {
  from: readonly string[];
  order: readonly string[];
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function useGtdShelves(prediction: ProjectOrderPrediction | null = null): GtdShelves {
  const data = useSidebarData();
  const roster = useMemo<PluginSidebarThread[]>(
    () => data.projects.flatMap((project) => project.threads),
    [data.projects],
  );
  const threads = useStableThreads(useHiddenWorkerActivity(roster));
  const now = useMinuteClock();
  const lifecycle = useLifecycle(threads);
  // The cut is made against the list's own clock, so a row ages off Settled
  // while the sidebar sits open rather than on the next unrelated refresh.
  useSettledArchivePaging({ experimental_archived: data.archived, threads: roster }, now);
  const shelved = useStableThreads(
    useMemo(
      () => threads.filter((thread) => !thread.isHidden && isShelvedThread(thread, now)),
      [now, threads],
    ),
  );
  const hosts = useMemo(() => [...data.hostsById.values()], [data.hostsById]);
  const machines = useMemo(() => sidebarMachines(shelved, hosts), [shelved, hosts]);
  const visibility = useMachineVisibility(machines);
  const scope = useAtomValue(projectScopeAtom);
  const scopeExists = scope === null || data.projects.some((project) => project.id === scope);
  const effectiveScope = scopeExists ? scope : null;
  const visibleThreads = useStableThreads(
    useMemo(
      () =>
        filterByProject(filterHiddenMachines(shelved, visibility.hiddenMachineIds), effectiveScope),
      [effectiveScope, shelved, visibility.hiddenMachineIds],
    ),
  );
  const pinnedIds = useMemo(
    () =>
      pinnedFamilyIds(
        visibleThreads,
        (thread) => !thread.isArchived && lifecycle.shelfFor(thread) === "active",
      ),
    [lifecycle, visibleThreads],
  );
  const pinnedThreads = useMemo(
    () => visibleThreads.filter((thread) => pinnedIds.has(thread.id)),
    [pinnedIds, visibleThreads],
  );
  // The arrival memory lives for the mount: a row keeps the place it earned
  // when it entered its shelf until it moves to another.
  const [arrivals] = useState(createShelfArrivals);
  const mode = useAtomValue(sidebarOrganizationModeAtom);
  const bbProjectOrder = useMemo(
    () => data.projects.filter((project) => !project.isPersonal).map((project) => project.id),
    [data.projects],
  );
  // By value: bb rebuilds its project list on every thread change, and only
  // a new order should drop the prediction.
  const projectOrder =
    prediction !== null && sameOrder(prediction.from, bbProjectOrder)
      ? prediction.order
      : bbProjectOrder;
  const personalProjectIds = useMemo(
    () =>
      new Set(data.projects.filter((project) => project.isPersonal).map((project) => project.id)),
    [data.projects],
  );
  const hostOrder = useMemo(() => hosts.map((host) => host.id), [hosts]);
  const layout = useMemo(() => {
    const forest = buildInboxTree(
      visibleThreads.filter((thread) => !pinnedIds.has(thread.id)),
      (thread) => (lifecycle.shelfFor(thread) === "snoozed" ? "snoozed" : "active"),
      { arrivals, snoozedAtFor: lifecycle.snoozedAtFor },
    );
    return buildShelfLayout({
      forest,
      mode,
      projectOrder,
      personalProjectIds,
      hostOrder,
      forceGroups: visibility.active,
    });
  }, [
    arrivals,
    hostOrder,
    lifecycle,
    mode,
    personalProjectIds,
    pinnedIds,
    projectOrder,
    visibility.active,
    visibleThreads,
  ]);
  return {
    status: data.status,
    ready:
      lifecycle.shelvesReady &&
      visibility.ready &&
      (data.archived === null || data.archived.status !== "loading"),
    data,
    threads,
    visibleThreads,
    pinnedThreads,
    layout,
    lifecycle,
    machines,
    visibility,
    scope: effectiveScope,
    bbProjectOrder,
    projectOrder,
  };
}
