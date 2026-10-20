import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { listedHiddenIds } from "./machine-visibility.ts";

export type SidebarMachine = NonNullable<PluginSidebarThread["host"]>;

/**
 * Every machine the picker offers: bb's known machines, including ones with
 * no threads yet, plus any machine a thread still names. A known machine's
 * record wins, so a rename shows before its threads refresh. Hosts older than
 * bb 0.44 omit `experimental_hosts`, and the threads alone decide.
 */
export function sidebarMachines(
  threads: readonly PluginSidebarThread[],
  hosts: readonly SidebarMachine[] = [],
): SidebarMachine[] {
  const machines = new Map<string, SidebarMachine>();
  for (const thread of threads) {
    if (thread.host) machines.set(thread.host.id, thread.host);
  }
  for (const host of hosts) machines.set(host.id, { id: host.id, name: host.name });
  return [...machines.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

export function machineVisibility(
  machines: readonly SidebarMachine[],
  hiddenIds: readonly string[],
) {
  const hiddenMachineIds: ReadonlySet<string> = listedHiddenIds(
    machines.map((machine) => machine.id),
    hiddenIds,
  );
  const visible = machines.filter((machine) => !hiddenMachineIds.has(machine.id));
  const active = hiddenMachineIds.size > 0;
  return {
    visible,
    hiddenMachineIds,
    active,
    composerHostId: active && visible.length === 1 ? visible[0]?.id : undefined,
  };
}

export function filterHiddenMachines(
  threads: readonly PluginSidebarThread[],
  hiddenIds: ReadonlySet<string>,
): readonly PluginSidebarThread[] {
  return hiddenIds.size === 0
    ? threads
    : threads.filter((thread) => thread.host === null || !hiddenIds.has(thread.host.id));
}
