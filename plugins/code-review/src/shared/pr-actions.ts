import { z } from "zod";

export type PrAction = "close" | "reopen" | "draft" | "ready" | "merge";
export type MergeMethod = "merge" | "squash" | "rebase";
export const prActionStateSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  mergeStateStatus: z.string(),
  canUpdate: z.boolean(),
  canMerge: z.boolean(),
  methods: z.array(z.enum(["merge", "squash", "rebase"])),
});
export type PrActionState = z.infer<typeof prActionStateSchema>;

/** The dialog and the server apply the same requirements to fresh GitHub state. */
export function prActionIssue({
  policy,
  action,
  headRefOid,
  method,
}: {
  policy: PrActionState;
  action: PrAction;
  headRefOid: string;
  method: MergeMethod;
}): string | null {
  if (policy.state === "MERGED") return "This pull request is already merged.";
  const expectedState = action === "reopen" ? "CLOSED" : "OPEN";
  if (policy.state !== expectedState)
    return "The pull request state changed. Refresh before trying again.";
  if (action !== "merge") {
    if (!policy.canUpdate) return "This account cannot update this pull request.";
    if ((action === "ready" && !policy.isDraft) || (action === "draft" && policy.isDraft))
      return "The draft state changed. Refresh before trying again.";
    return null;
  }
  if (!policy.canMerge) return "This account cannot merge this pull request.";
  if (policy.headRefOid !== headRefOid)
    return "The branch changed. Review the latest commit before merging.";
  if (policy.isDraft) return "Mark the pull request ready before merging.";
  if (!["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(policy.mergeStateStatus))
    return `GitHub blocks merging: ${policy.mergeStateStatus}. Resolve the requirements or use GitHub for merge queues.`;
  if (!policy.methods.includes(method)) return "This repository does not allow that merge method.";
  return null;
}
