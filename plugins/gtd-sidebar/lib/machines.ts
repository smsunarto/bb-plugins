import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type SidebarMachine = NonNullable<PluginSidebarThread["host"]>;

const MACHINE_COLORS = [
  "var(--ansi-4)",
  "var(--ansi-6)",
  "var(--ansi-5)",
  "var(--ansi-3)",
  "var(--ansi-2)",
  "var(--ansi-1)",
] as const;

export function machineColor(hostId: string): string {
  let hash = 0;
  for (const character of hostId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return MACHINE_COLORS[hash % MACHINE_COLORS.length]!;
}

export function sidebarMachines(threads: readonly PluginSidebarThread[]): SidebarMachine[] {
  const machines = new Map<string, SidebarMachine>();
  for (const thread of threads) {
    if (thread.host) machines.set(thread.host.id, thread.host);
  }
  return [...machines.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

export function filterByMachine(
  threads: readonly PluginSidebarThread[],
  hostId: string | null,
): readonly PluginSidebarThread[] {
  return hostId === null ? threads : threads.filter((thread) => thread.host?.id === hostId);
}
