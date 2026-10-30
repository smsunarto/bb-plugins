import { useEffect, useState } from "react";
import { useSdk, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

// GTD Sidebar (lib/) and GitButler (src/app/) each carry this file byte for
// byte, so machine appearance matches across both plugins. Edit both copies;
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

/** An ID always gets the same palette slot, regardless of the machine roster. */
export function machineColor(hostId: string): string {
  return PALETTE[hashedSlot(hostId)]!;
}

export function machineColors(_roster: Iterable<string>): (hostId: string) => string {
  return machineColor;
}

export function useRosterColors(
  _hosts: readonly { id: string }[] | undefined,
): (hostId: string) => string {
  return machineColor;
}

/** Sidebar summaries omit provider identity; read it from the server's host catalog. */
export function useBoatMachineIds(
  hosts: readonly { id: string }[] | undefined,
): ReadonlySet<string> {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const rosterKey =
    hosts
      ?.map((host) => host.id)
      .sort()
      .join("\n") ?? "";
  useEffect(() => {
    if (connection !== "connected") return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => sdk.hosts.list({ signal: controller.signal }))
      .then(
        (machines) => {
          if (!controller.signal.aborted) {
            setIds(
              new Set(
                machines
                  .filter((machine) => machine.machineProviderId === "boat-sandbox")
                  .map((machine) => machine.id),
              ),
            );
          }
          return undefined;
        },
        () => {},
      );
    return () => controller.abort();
    // Refresh provider identity when machines join/leave or the server reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, rosterKey, connection]);
  return ids;
}
