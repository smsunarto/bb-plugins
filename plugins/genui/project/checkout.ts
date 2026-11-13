// A thread environment's checkout and pull request, read through other
// plugins: the checkout through Source Control's plain-git reads
// (`checkoutStatus`, `checkoutFiles`, `checkoutPatches`), so bb's bundled Git
// plugin can stay disabled, and the pull request through bb's GitHub PR
// status plugin. The schemas copy only the fields this plugin reads; zod
// drops the rest.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type Sdk = BbPluginApi["sdk"];

const SOURCE_CONTROL = "source-control";
const PULL_REQUESTS = "bb--github-pr-status";

const problemSchema = z.object({
  kind: z.string(),
  host: z.string().optional(),
  detail: z.string().optional(),
});

/** Why Source Control couldn't read the checkout. */
export type CheckoutProblem = z.infer<typeof problemSchema>;

function read<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), problem: problemSchema }),
  ]);
}

const headSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("detached"), sha: z.string() }),
  z.object({ kind: z.literal("unborn"), name: z.string().nullable() }),
]);

/** What is checked out. */
export type CheckoutHead = z.infer<typeof headSchema>;

const statusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("not-git") }),
  z.object({
    state: z.literal("read"),
    head: headSchema,
    defaultBranch: z.string().nullable(),
    base: z.string().nullable(),
    uncommitted: z.object({ files: z.number(), additions: z.number(), deletions: z.number() }),
    mergeBase: z
      .object({
        ahead: z.number(),
        behind: z.number(),
        // Newest first.
        commits: z.array(
          z.object({
            sha: z.string(),
            subject: z.string(),
            author: z.string(),
            authoredAt: z.number(),
          }),
        ),
      })
      .nullable(),
  }),
]);

/** A checkout Source Control could read. */
export type CheckoutRead = Extract<z.infer<typeof statusSchema>, { state: "read" }>;

/** What a diff compares, as Source Control names it. */
export type CheckoutTarget =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "branch"; readonly base: string }
  | { readonly kind: "commit"; readonly sha: string };

const patchSchema = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });

const fileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  kind: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  untracked: z.boolean(),
});

/** One changed file, as `checkoutFiles` lists it. */
export type CheckoutFile = z.infer<typeof fileSchema>;

const filesSchema = read(
  z.object({ files: z.array(fileSchema), truncated: z.boolean(), patches: z.array(patchSchema) }),
);
const patchesSchema = read(z.object({ patches: z.array(patchSchema) }));

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

/** The checkout measured against `base`; null measures against its default branch. */
export function checkoutStatus(sdk: Sdk, environmentId: string, base: string | null) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "checkoutStatus",
    input: { environmentId, base },
    outputSchema: read(statusSchema),
  });
}

export function checkoutFiles(sdk: Sdk, environmentId: string, target: CheckoutTarget) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "checkoutFiles",
    input: { environmentId, target },
    outputSchema: filesSchema,
  });
}

/** Most files one `checkoutPatches` call takes. */
export const PATCH_BATCH = 25;

export function checkoutPatches(
  sdk: Sdk,
  environmentId: string,
  target: CheckoutTarget,
  files: readonly Pick<CheckoutFile, "path" | "previousPath">[],
) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "checkoutPatches",
    input: {
      environmentId,
      target,
      files: files.map(({ path, previousPath }) => ({ path, previousPath })),
    },
    outputSchema: patchesSchema,
  });
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

const prStatusSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  isDraft: z.boolean(),
  baseRef: z.string(),
  headRef: z.string(),
  updatedAt: z.string().nullable(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  mergeStateStatus: z.string().nullable(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  reviewRequests: z.number(),
  checks: z.object({ passed: z.number(), failed: z.number(), pending: z.number() }),
  autoMerge: z.boolean(),
  inMergeQueue: z.boolean(),
});

/** A pull request as Source Control reads it by reference: GitHub's facts, unlabelled. */
export type PrStatus = z.infer<typeof prStatusSchema>;

const prStatusesSchema = z.record(
  z.string(),
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: prStatusSchema }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["not-found", "unavailable"]),
      message: z.string(),
    }),
  ]),
);

/**
 * Pull requests by reference (at most 20), keyed `owner/repo#N`: each
 * repository read as the bb server's GitHub account, else the environment's
 * host's. Throws when Source Control can't be asked (disabled, or too old).
 */
export function pullRequestsByRef(
  sdk: Sdk,
  environmentId: string | null,
  refs: readonly { owner: string; repo: string; number: number }[],
) {
  return sdk.plugins.callRpc({
    pluginId: SOURCE_CONTROL,
    method: "pullRequestsByRef",
    input: {
      environmentId,
      refs: refs.map(({ owner, repo, number }) => ({ owner, repo, number })),
    },
    outputSchema: prStatusesSchema,
  });
}
