import type { PrLifecycle } from "./pr-metadata";

export type ActionBranch = {
  name: string;
  pr: { number: number; lifecycle: PrLifecycle } | null;
};

export type StackMergeMethod = "squash" | "merge" | "rebase";

export function stackMergeArgs(throughPrNumber: number, method: StackMergeMethod): string[] {
  return ["stack", "merge", String(throughPrNumber), "--yes", "--merge-method", method];
}

export function stackMergeWasQueued(stdout: string, stderr: string): boolean {
  return /\b(?:enqueued|queued)\b|merge queue/i.test(`${stdout}\n${stderr}`);
}

export function pruneCandidates(branches: readonly ActionBranch[]): string[] {
  return branches
    .filter((branch) => branch.pr?.lifecycle === "merged")
    .map((branch) => branch.name);
}

export function mergePrefix<T extends ActionBranch>(
  branches: readonly T[],
  throughPrNumber?: number,
): { selected: T[]; blocker: T | null; pinned: boolean } {
  const active = branches.filter((branch) => branch.pr?.lifecycle !== "merged");
  const selected: T[] = [];
  let blocker: T | null = null;
  for (const branch of active) {
    const pr = branch.pr;
    if (!pr || (pr.lifecycle !== "open" && pr.lifecycle !== "queued")) {
      blocker = branch;
      break;
    }
    selected.push(branch);
    if (pr.number === throughPrNumber) {
      return { selected, blocker: null, pinned: true };
    }
  }
  return {
    selected: throughPrNumber === undefined ? selected : [],
    blocker,
    pinned: throughPrNumber === undefined,
  };
}
