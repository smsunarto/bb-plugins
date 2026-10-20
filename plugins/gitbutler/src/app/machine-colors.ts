import { useMemo } from "react";

// GTD Sidebar (lib/) and GitButler (src/app/) each carry this file byte for
// byte, so a machine's globe matches across both plugins. Edit both copies;
// plugins/gitbutler/test/machine-colors.test.ts fails when they differ.

// A globe sits beside status glyphs, so no entry may read as error, attention,
// success, or merged. That leaves blue through cyan, plus pink, and lightness
// tells entries of one hue apart. A theme names the hues with --machine-1 to
// --machine-6, as bb Monokai does. Other themes get these [light, dark] pairs,
// each at least 3:1 on the selected sidebar row of bb's own light and dark themes.
const PALETTE = [
  ["#0c7cf4", "#2987f8"], // blue
  ["#358793", "#07c3de"], // cyan
  ["#015e4e", "#6dfee5"], // mint
  ["#c52c7c", "#fd7ec8"], // pink
  ["#3d408a", "#aaa0fb"], // lavender
  ["#85067c", "#fec4ff"], // orchid
].map(([light, dark], index) => `var(--machine-${index + 1}, light-dark(${light}, ${dark}))`);

function hashedSlot(hostId: string): number {
  let hash = 0;
  for (const character of hostId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % PALETTE.length;
}

/**
 * Colors each machine in `roster` by host ID. Machines never share a color
 * until the roster outgrows the palette, and past that each color repeats as
 * few times as possible. In ID order, a machine takes its hashed slot or, when
 * an earlier ID holds it, the next free one. Renames and display order never
 * change a color. Adding or removing a machine can move only machines whose
 * IDs sort after it, since one probe can push the next. An ID outside the
 * roster gets its hashed slot.
 */
export function machineColors(roster: Iterable<string>): (hostId: string) => string {
  const slots = new Map<string, number>();
  let taken = new Set<number>();
  for (const hostId of [...new Set(roster)].sort()) {
    if (taken.size === PALETTE.length) taken = new Set();
    let slot = hashedSlot(hostId);
    while (taken.has(slot)) slot = (slot + 1) % PALETTE.length;
    taken.add(slot);
    slots.set(hostId, slot);
  }
  return (hostId) => PALETTE[slots.get(hostId) ?? hashedSlot(hostId)]!;
}

/**
 * `machineColors` over bb's machine list, kept stable until a machine joins or
 * leaves so context consumers skip re-rendering.
 */
export function useRosterColors(
  hosts: readonly { id: string }[] | undefined,
): (hostId: string) => string {
  const rosterKey = [...new Set(hosts?.map((host) => host.id))].sort().join("\n");
  return useMemo(() => machineColors(rosterKey ? rosterKey.split("\n") : []), [rosterKey]);
}
