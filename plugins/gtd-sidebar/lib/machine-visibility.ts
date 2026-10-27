// The contract's schema in rpc-contract.ts is checked against these types.
export type MachineVisibilityChange =
  | { kind: "all" }
  | { kind: "set"; machineId: string; visible: boolean; machineIds: string[] }
  | { kind: "only"; machineId: string; machineIds: string[] };

/**
 * The listed machines a saved preference hides. An id no listed machine
 * carries hides nothing until that machine returns. When the preference
 * would hide every listed machine, as after the visible one leaves bb, every
 * machine shows instead, so the list never empties.
 */
export function listedHiddenIds(
  machineIds: readonly string[],
  hiddenIds: readonly string[],
): Set<string> {
  const saved = new Set(hiddenIds);
  const hidden = new Set(machineIds.filter((id) => saved.has(id)));
  return hidden.size === machineIds.length ? new Set() : hidden;
}

/** Commands describe the desired result, so retries never flip a checkbox back. */
export function changeHiddenMachines(
  hiddenIds: readonly string[],
  change: MachineVisibilityChange,
): string[] {
  if (change.kind === "all") return [];
  if (!change.machineIds.includes(change.machineId)) return [...hiddenIds];
  // Start from what the menu showed: a preference that hid every listed
  // machine showed all of them, so it must not survive a toggle.
  const listed = new Set(change.machineIds);
  const menuHidden = listedHiddenIds(change.machineIds, hiddenIds);
  const hidden = new Set(hiddenIds.filter((id) => !listed.has(id) || menuHidden.has(id)));
  if (change.kind === "only") {
    for (const id of change.machineIds) hidden.add(id);
    hidden.delete(change.machineId);
  } else if (change.visible) {
    hidden.delete(change.machineId);
  } else {
    // Another window may already have hidden every other machine.
    if (!change.machineIds.some((id) => id !== change.machineId && !hidden.has(id))) {
      return [...hiddenIds];
    }
    hidden.add(change.machineId);
  }
  return [...hidden].sort();
}
