/**
 * Merging a pull request over `gh`. Ported from code-review
 * (`src/server/lib/pr-actions.ts`, `src/server/rpc/pr-action.ts`): the policy
 * is one GraphQL read, and the merge is GitHub's REST merge with `sha`, so
 * GitHub itself refuses when the head moved after the read. Never retried: a
 * lost answer leaves the outcome unknown, and the caller reads the pull
 * request again to find out.
 */
import { z } from "zod";
import type { ForgeResult } from "../core/change.ts";
import type { Repo } from "../core/ids.ts";
import { mergeIssue, type MergeMethod, type MergePolicy } from "../core/merge.ts";
import { classifyFailure, GhError, type Exec } from "./github.ts";
import { graphql } from "./review.ts";

const POLICY_QUERY = `query MergePolicy($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerPermission
    pullRequest(number: $number) { state isDraft headRefOid baseRefName mergeStateStatus }
  }
}`;

const policyAnswer = z.object({
  repository: z.object({
    mergeCommitAllowed: z.boolean(),
    squashMergeAllowed: z.boolean(),
    rebaseMergeAllowed: z.boolean(),
    viewerPermission: z.string().nullable(),
    pullRequest: z.object({
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      isDraft: z.boolean(),
      headRefOid: z.string(),
      baseRefName: z.string(),
      mergeStateStatus: z.string(),
    }),
  }),
});

/** Fresh repository policy and the acting account's merge permission for one pull request. */
export async function readMergePolicy(
  exec: Exec,
  target: { repo: Repo; number: number },
  signal?: AbortSignal,
): Promise<MergePolicy> {
  const { repository } = policyAnswer.parse(
    await graphql(
      exec,
      POLICY_QUERY,
      { owner: target.repo.owner, name: target.repo.name, number: target.number },
      signal,
    ),
  );
  const methods: MergeMethod[] = [];
  if (repository.mergeCommitAllowed) methods.push("merge");
  if (repository.squashMergeAllowed) methods.push("squash");
  if (repository.rebaseMergeAllowed) methods.push("rebase");
  return {
    ...repository.pullRequest,
    canMerge: ["WRITE", "MAINTAIN", "ADMIN"].includes(repository.viewerPermission ?? ""),
    methods,
  };
}

export type MergeWrite = {
  repo: Repo;
  number: number;
  method: MergeMethod;
  expectedHead: string;
  expectedBase: string;
};

/**
 * Merges the pull request only while it is still at `expectedHead` into
 * `expectedBase`. Already merged is `upToDate`; a moved head or base is
 * `conflict`; any other unmet requirement throws a `GhError` naming it.
 */
export async function mergeAt(
  exec: Exec,
  write: MergeWrite,
  signal?: AbortSignal,
): Promise<ForgeResult> {
  const policy = await readMergePolicy(exec, write, signal);
  if (policy.state === "MERGED") return { status: "upToDate" };
  if (policy.headRefOid !== write.expectedHead)
    return {
      status: "conflict",
      detail: `#${write.number} moved to ${policy.headRefOid.slice(0, 7)} since you looked.`,
    };
  if (policy.baseRefName !== write.expectedBase)
    return {
      status: "conflict",
      detail: `#${write.number} now targets ${policy.baseRefName}, not ${write.expectedBase}.`,
    };
  const issue = mergeIssue({
    policy,
    head: write.expectedHead,
    base: write.expectedBase,
    method: write.method,
  });
  if (issue) throw new GhError("failed", issue);
  const path = `repos/${write.repo.owner}/${write.repo.name}/pulls/${write.number}/merge`;
  const result = await exec(["api", "--method", "PUT", path, "--input", "-"], {
    stdin: JSON.stringify({ sha: write.expectedHead, merge_method: write.method }),
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0 || result.failure) throw classifyFailure(result);
  const answer = z
    .object({ merged: z.boolean(), message: z.string() })
    .safeParse(JSON.parse(result.stdout || "{}"));
  if (!answer.success)
    throw new GhError("failed", "GitHub answered the merge in a way not understood.");
  if (!answer.data.merged) throw new GhError("failed", answer.data.message);
  return { status: "done" };
}
