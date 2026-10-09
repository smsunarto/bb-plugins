import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type SidebarMachine = NonNullable<PluginSidebarThread["host"]>;

// A globe sits beside status glyphs, so its hue must never read as error,
// attention, success, or merged. bb Monokai defines these identity tokens.
// Other themes fall back to ANSI blue, cyan, and magenta, plus a magenta eased
// further toward the text color: bb's default bright ANSI slots sit too close
// to their base slots to tell two machines apart. Easing blue and magenta 12%
// toward the text keeps them at 3:1 on the selected row in bb's dark theme.
// 52% keeps the eased magenta as far from the base one as blue sits from cyan.
const MACHINE_COLORS = [
  "var(--machine-1, color-mix(in oklab, var(--ansi-4) 88%, var(--foreground)))",
  "var(--machine-2, var(--ansi-6))",
  "var(--machine-3, color-mix(in oklab, var(--ansi-5) 88%, var(--foreground)))",
  "var(--machine-4, color-mix(in oklab, var(--ansi-5) 52%, var(--foreground)))",
] as const;

export function machineColor(hostId: string): string {
  let hash = 0;
  for (const character of hostId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return MACHINE_COLORS[hash % MACHINE_COLORS.length]!;
}

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

export function filterByMachine(
  threads: readonly PluginSidebarThread[],
  hostId: string | null,
): readonly PluginSidebarThread[] {
  return hostId === null ? threads : threads.filter((thread) => thread.host?.id === hostId);
}
