// BB's git and pull-request reads, through the bundled Git (`bb--git`) and
// GitHub PR status (`bb--github-pr-status`) plugins. BB 0.49 retired
// `environments.status`, `diffFiles`, `diffPatch` and `pullRequest` from the
// SDK in their favour. The schemas copy only the fields this plugin reads
// (bb-plugin-authoring, references/git-reads.md); zod drops the rest.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type Sdk = BbPluginApi["sdk"];

const GIT = "bb--git";
const PULL_REQUESTS = "bb--github-pr-status";

const notApplicable = z.object({ outcome: z.literal("not_applicable"), message: z.string() });
const unavailable = z.object({
  outcome: z.literal("unavailable"),
  failure: z.object({ code: z.string(), message: z.string(), workspacePath: z.string() }),
});

const workspace = z.object({
  checkout: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("branch"), branchName: z.string(), headSha: z.string().nullable() }),
    z.object({ kind: z.literal("detached"), headSha: z.string().nullable() }),
    z.object({ kind: z.literal("unborn"), branchName: z.string().nullable() }),
    z.object({ kind: z.literal("unknown"), reason: z.string() }),
  ]),
  branch: z.object({ defaultBranch: z.string() }),
  workingTree: z.object({
    files: z.array(z.unknown()),
    insertions: z.number(),
    deletions: z.number(),
    lineStatsComplete: z.boolean(),
  }),
  mergeBase: z
    .object({
      aheadCount: z.number(),
      behindCount: z.number(),
      commits: z.array(
        z.object({
          sha: z.string(),
          shortSha: z.string(),
          subject: z.string(),
          authorName: z.string(),
          authoredAt: z.number(),
        }),
      ),
    })
    .nullable(),
});

/** A workspace as workspaceStatus reports it, with the fields this plugin reads. */
export type GitWorkspace = z.infer<typeof workspace>;

const workspaceStatusSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), workspace }),
  notApplicable,
  unavailable,
]);

/** A diff target, as the Git plugin names it. */
export type GitTarget =
  | { readonly type: "uncommitted" }
  | { readonly type: "all"; readonly mergeBaseBranch: string }
  | { readonly type: "commit"; readonly sha: string };

const patchSchema = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });

const fileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  origin: z.enum(["tracked", "untracked"]),
  loadMode: z.enum(["auto", "on_demand", "too_large"]),
  revision: z.string(),
});

/** One changed file, as `files` lists it. */
export type GitFile = z.infer<typeof fileSchema>;

const filesSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    files: z.array(fileSchema),
    truncated: z.boolean(),
    initialPatches: z.array(patchSchema),
  }),
  notApplicable,
  unavailable,
]);

const patchesSchema = z.record(
  z.string(),
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("available"), patch: patchSchema }),
    notApplicable,
    unavailable,
  ]),
);

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  baseRefName: z.string(),
  headRefName: z.string(),
  updatedAt: z.string(),
  autoMerge: z.boolean(),
  inMergeQueue: z.boolean().nullable(),
  checks: z.object({
    state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
    passedCount: z.number(),
    failedCount: z.number(),
    pendingCount: z.number(),
    totalCount: z.number(),
  }),
  review: z.object({
    state: z.enum(["approved", "changes_requested", "review_requested", "review_required", "none"]),
    reviewRequestCount: z.number(),
  }),
  mergeability: z.object({
    state: z.enum(["mergeable", "conflicts", "blocked", "draft", "unknown"]),
  }),
  attention: z.enum([
    "checks_failed",
    "checks_pending",
    "changes_requested",
    "review_requested",
    "conflicts",
    "blocked",
    "draft",
    "queued",
    "ready_to_merge",
    "merged",
    "closed",
    "none",
  ]),
});

const pullRequestsSchema = z.record(
  z.string(),
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("available"), pullRequest: pullRequestSchema }),
    z.object({ outcome: z.literal("absent") }),
    z.object({ outcome: z.literal("unavailable"), message: z.string() }),
  ]),
);

/** The Git plugin's patch key: one file of one diff at one revision. */
export function gitPatchKey(
  environmentId: string,
  target: GitTarget,
  path: string,
  revision: string,
): string {
  return JSON.stringify([environmentId, target, false, path, revision]);
}

export function workspaceStatus(sdk: Sdk, environmentId: string, mergeBaseBranch: string | null) {
  return sdk.plugins.callRpc({
    pluginId: GIT,
    method: "workspaceStatus",
    input: { environmentId, ...(mergeBaseBranch === null ? {} : { mergeBaseBranch }) },
    outputSchema: workspaceStatusSchema,
  });
}

export function changedFiles(sdk: Sdk, environmentId: string, target: GitTarget) {
  return sdk.plugins.callRpc({
    pluginId: GIT,
    method: "files",
    input: { environmentId, target, ignoreWhitespace: false },
    outputSchema: filesSchema,
  });
}

/** Each file's patch, in `files` order; files whose read failed are left out. */
export async function filePatches(
  sdk: Sdk,
  environmentId: string,
  target: GitTarget,
  files: readonly Pick<GitFile, "path" | "revision">[],
) {
  const keys = files.map((file) => gitPatchKey(environmentId, target, file.path, file.revision));
  const answer = await sdk.plugins.callRpc({
    pluginId: GIT,
    method: "patches",
    input: { keys },
    outputSchema: patchesSchema,
  });
  const rows = keys.map((key) => answer[key]);
  const patches = rows.flatMap((row) => (row?.outcome === "available" ? [row.patch] : []));
  const failed = rows.flatMap((row) =>
    row === undefined || row.outcome === "available" ? [] : [row],
  )[0];
  return { patches, failed };
}

/** The pull request for the environment's current branch, or why there is none. */
export async function pullRequest(sdk: Sdk, environmentId: string) {
  const answer = await sdk.plugins.callRpc({
    pluginId: PULL_REQUESTS,
    method: "pullRequests",
    input: { keys: [environmentId] },
    outputSchema: pullRequestsSchema,
  });
  return (
    answer[environmentId] ?? {
      outcome: "unavailable" as const,
      message: "BB didn't report a pull request",
    }
  );
}
