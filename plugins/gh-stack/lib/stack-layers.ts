/**
 * A stack whose every layer is merged cannot be extended: `gh stack top` has
 * no branch to check out, because merged layer branches are normally pruned
 * locally and on the remote. Only the layers that survive make a stack
 * extendable; without one, new work starts a stack of its own.
 */
export function hasExtendableLayers<
  T extends { isMerged: boolean; pr?: { state: string } | null },
>(branches: readonly T[]): boolean {
  return branches.some((branch) => !branch.isMerged && branch.pr?.state !== "MERGED");
}

export type StackLayerCheckout = {
  mergedBranch: string;
  target:
    | { kind: "branch"; name: string }
    | { kind: "trunk"; name: string };
};

// gh-stack keeps merged branches in its bottom-to-top metadata. The panel
// projects them away, and only moves checkout when the current branch itself
// is one of those hidden layers.
export function projectStackLayers<T extends { name: string; isMerged: boolean }>(
  branches: readonly T[],
  trunk: string,
  currentBranch: string | null,
): { visibleBranches: T[]; checkout: StackLayerCheckout | null } {
  const visibleBranches = branches.filter((branch) => !branch.isMerged);
  if (!currentBranch) return { visibleBranches, checkout: null };

  const currentIndex = branches.findIndex((branch) => branch.name === currentBranch);
  if (currentIndex < 0 || !branches[currentIndex].isMerged) {
    return { visibleBranches, checkout: null };
  }

  const above = branches
    .slice(currentIndex + 1)
    .find((branch) => !branch.isMerged);
  return {
    visibleBranches,
    checkout: {
      mergedBranch: currentBranch,
      target: above
        ? { kind: "branch", name: above.name }
        : { kind: "trunk", name: trunk },
    },
  };
}
