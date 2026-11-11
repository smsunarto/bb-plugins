/**
 * Merging a pull request: the methods a repository allows, what GitHub says
 * about this pull request and this account right now, and the requirements a
 * merge must meet. Ported from `plugins/code-review/src/shared/pr-actions.ts`;
 * the dialog and the forge write apply the same requirements to fresh state.
 */
import { z } from "zod";

export const mergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof mergeMethodSchema>;

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** Fresh repository policy and authorization for one pull request and the acting account. */
export const mergePolicySchema = z
  .object({
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    headRefOid: z.string(),
    baseRefName: z.string(),
    /** GitHub's `mergeStateStatus`: CLEAN, HAS_HOOKS, UNSTABLE, BLOCKED, BEHIND, DIRTY, UNKNOWN… */
    mergeStateStatus: z.string(),
    canMerge: z.boolean(),
    methods: z.array(mergeMethodSchema),
  })
  .strict();
export type MergePolicy = z.infer<typeof mergePolicySchema>;

/** Merge states GitHub merges directly; the rest need GitHub itself (queues, rules, conflicts). */
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/**
 * Why this pull request cannot be merged at the head and base the reader saw
 * with `method`, or null when it can.
 */
export function mergeIssue({
  policy,
  head,
  base,
  method,
}: {
  policy: MergePolicy;
  head: string;
  base: string;
  method: MergeMethod;
}): string | null {
  if (policy.state === "MERGED") return "This pull request is already merged.";
  if (policy.state !== "OPEN")
    return "The pull request state changed. Refresh before trying again.";
  if (!policy.canMerge) return "This account cannot merge this pull request.";
  if (policy.headRefOid !== head)
    return "The branch changed. Review the latest commit before merging.";
  if (policy.baseRefName !== base) return "The destination branch changed. Refresh before merging.";
  if (policy.isDraft) return "Mark the pull request ready before merging.";
  if (!MERGEABLE_STATES.has(policy.mergeStateStatus))
    return `GitHub blocks merging: ${policy.mergeStateStatus}. Resolve the requirements or use GitHub for merge queues.`;
  if (!policy.methods.includes(method)) return "This repository does not allow that merge method.";
  return null;
}

/** The method the dialog starts on: the reader's last choice when the repository allows it. */
export function initialMethod(methods: readonly MergeMethod[], chosen: MergeMethod): MergeMethod {
  return methods.includes(chosen) ? chosen : (methods[0] ?? chosen);
}
