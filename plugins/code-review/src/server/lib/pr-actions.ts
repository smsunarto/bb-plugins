import { z } from "zod";
export { prActionStateSchema } from "../../shared/pr-actions.ts";
import type { PrRef } from "../../shared/schema.ts";
import type { Gh } from "./gh.ts";

/** Fresh authorization and repository policy for a specific PR and acting account. */
export async function loadPrActionState(gh: Gh, ref: PrRef) {
  const response = z
    .object({
      repository: z.object({
        mergeCommitAllowed: z.boolean(),
        squashMergeAllowed: z.boolean(),
        rebaseMergeAllowed: z.boolean(),
        viewerPermission: z.string().nullable(),
        pullRequest: z.object({
          state: z.enum(["OPEN", "CLOSED", "MERGED"]),
          isDraft: z.boolean(),
          headRefOid: z.string(),
          mergeStateStatus: z.string(),
          viewerCanUpdate: z.boolean(),
        }),
      }),
    })
    .parse(
      await gh.graphql(
        `query PrActionState($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerPermission
      pullRequest(number: $number) { state isDraft headRefOid mergeStateStatus viewerCanUpdate }
    }
  }`,
        { owner: ref.owner, name: ref.repo, number: ref.number },
      ),
    );
  const repo = response.repository;
  const { viewerCanUpdate, ...pr } = repo.pullRequest;
  const methods: ("merge" | "squash" | "rebase")[] = [];
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  return {
    ...pr,
    canUpdate: viewerCanUpdate,
    canMerge: ["WRITE", "MAINTAIN", "ADMIN"].includes(repo.viewerPermission ?? ""),
    methods,
  };
}
