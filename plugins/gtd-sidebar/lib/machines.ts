import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { listedHiddenIds } from "./machine-visibility.ts";

export type SidebarMachine = NonNullable<PluginSidebarThread["host"]>;

/**
 * bb passes its full host records, but the SDK types only `id` and `name`.
 * `type` is read defensively until the contract exposes it.
 */
type SidebarHost = SidebarMachine & { type?: unknown };

/**
 * Every machine the picker offers. bb's persistent machines, including ones
 * with no threads yet, decide the list. Disposable sandboxes come and go per
 * task, and a thread whose machine bb no longer knows names it only by its
 * id, so neither adds an entry. Hosts older than bb 0.44 omit
 * `experimental_hosts`, and an empty roster is still loading, so the threads
 * alone decide then.
 */
export function sidebarMachines(
  threads: readonly PluginSidebarThread[],
  hosts: readonly SidebarHost[] = [],
): SidebarMachine[] {
  const machines = new Map<string, SidebarMachine>();
  if (hosts.length === 0) {
    for (const thread of threads) {
      if (thread.host) machines.set(thread.host.id, thread.host);
    }
  }
  for (const host of hosts) {
    if (host.type !== "ephemeral") machines.set(host.id, { id: host.id, name: host.name });
  }
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
