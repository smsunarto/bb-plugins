import {
  rawIsMerged,
  type PrLifecycle,
  type StackPrState,
  type VisiblePrLifecycle,
} from "./pr-metadata";

/**
 * A stack whose every layer is merged cannot be extended: `gh stack top` has
 * no branch to check out, because merged layer branches are normally pruned
 * locally and on the remote. Only the layers that survive make a stack
 * extendable; without one, new work starts a stack of its own. Reads raw
 * `gh stack view` rows, before any GitHub enrichment.
 */
export function hasExtendableLayers(
  branches: readonly { isMerged: boolean; pr?: { state: StackPrState } | null }[],
): boolean {
  return branches.some((branch) => !rawIsMerged(branch));
}

export type StackLayerCheckout = {
  mergedBranch: string;
  target: { kind: "branch"; name: string } | { kind: "trunk"; name: string };
};

type Layer = { name: string; pr: { lifecycle: PrLifecycle } | null };

// A layer the panel can see: its PR, if it has one, is not merged.
export type VisibleLayer<T extends Layer> = T & { pr: { lifecycle: VisiblePrLifecycle } | null };

// gh-stack keeps merged branches in its bottom-to-top metadata. The panel
// projects them away, and only moves checkout when the current branch itself
// is one of those hidden layers.
export function projectStackLayers<T extends Layer>(
  branches: readonly T[],
  trunk: string,
  currentBranch: string | null,
): { visibleBranches: VisibleLayer<T>[]; checkout: StackLayerCheckout | null } {
  const isMerged = (branch: T) => branch.pr?.lifecycle === "merged";
  const visibleBranches = branches.filter((branch): branch is VisibleLayer<T> => !isMerged(branch));
  if (!currentBranch) return { visibleBranches, checkout: null };

  const currentIndex = branches.findIndex((branch) => branch.name === currentBranch);
  const current = branches[currentIndex];
  if (current === undefined || !isMerged(current)) {
    return { visibleBranches, checkout: null };
  }

  const above = branches.slice(currentIndex + 1).find((branch) => !isMerged(branch));
  return {
    visibleBranches,
    checkout: {
      mergedBranch: currentBranch,
      target: above ? { kind: "branch", name: above.name } : { kind: "trunk", name: trunk },
    },
  };
}
