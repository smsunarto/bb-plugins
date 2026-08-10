export type ActionBranch = {
  name: string;
  isMerged: boolean;
  pr: { number: number; state: string; isDraft?: boolean } | null;
};

export function pruneCandidates(branches: readonly ActionBranch[]): string[] {
  return branches
    .filter((branch) => branch.isMerged || branch.pr?.state === "MERGED")
    .map((branch) => branch.name);
}

export function mergePrefix(
  branches: readonly ActionBranch[],
  throughPrNumber?: number,
): { selected: ActionBranch[]; blocker: ActionBranch | null; pinned: boolean } {
  const active = branches.filter((branch) => !branch.isMerged && branch.pr?.state !== "MERGED");
  const selected: ActionBranch[] = [];
  let blocker: ActionBranch | null = null;
  for (const branch of active) {
    if (
      !branch.pr ||
      branch.pr.isDraft ||
      (branch.pr.state !== "OPEN" && !branch.pr.state.includes("QUEUE"))
    ) {
      blocker = branch;
      break;
    }
    selected.push(branch);
    if (branch.pr.number === throughPrNumber) {
      return { selected, blocker: null, pinned: true };
    }
  }
  return {
    selected: throughPrNumber === undefined ? selected : [],
    blocker,
    pinned: throughPrNumber === undefined,
  };
}
