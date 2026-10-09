import { z } from "zod";

/**
 * The wire model. `but --json` is the only source for workspace shape, so
 * every field here is something the CLI already knows; the host narrows the
 * CLI's freeform strings to these unions and never invents a value.
 */

export const environmentPathSchema = z.string().min(1).max(16_384);
/** Relative to the environment root, or "." for the root repository itself. */
export const repositoryKeySchema = z.string().min(1).max(1024);
export const commitIdSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/);

export const changeKindSchema = z.enum(["added", "modified", "deleted", "renamed", "copied"]);

export const fileChangeSchema = z.object({ path: z.string(), kind: changeKindSchema }).strict();

export const commitSchema = z
  .object({
    commitId: z.string(),
    changeId: z.string().nullable(),
    message: z.string(),
    authorName: z.string(),
    createdAt: z.string(),
    conflicted: z.boolean(),
  })
  .strict();

/** GitButler's push status for a branch head, plus the raw CLI string. */
export const branchStatusSchema = z.enum([
  "unpushed",
  "pushed",
  "ahead",
  /** The remote has commits this branch lacks, and this branch has nothing the remote lacks. */
  "behind",
  "diverged",
  "integrated",
  "conflicted",
  "empty",
  "unknown",
]);

/** What a Push button would do: nothing to send, a plain push, or a force push. */
export const pushModeSchema = z.enum(["none", "push", "force"]);

export const branchSchema = z
  .object({
    name: z.string(),
    status: branchStatusSchema,
    rawStatus: z.string(),
    push: pushModeSchema,
    /** The forge's own form, symbol included: "#42" on GitHub, "!42" on GitLab. */
    reviewId: z.string().nullable(),
    /** The review's checks overall. Null with no review, no checks, or no verdict. */
    ci: z.enum(["pending", "success", "failure"]).nullable(),
    commits: z.array(commitSchema),
    upstreamCommits: z.array(commitSchema),
    /**
     * Upstream commits with no equivalent here: what Pull brings in, and what
     * a force push deletes. A rebased branch's remote still holds its old
     * copies, which show as upstream commits but lose nothing when replaced.
     */
    newUpstream: z.number().int().nonnegative(),
  })
  .strict();

export const stackSchema = z
  .object({
    /** Stable across refreshes: the bottom branch name. CLI ids are not. */
    key: z.string(),
    branches: z.array(branchSchema),
    assignedChanges: z.array(fileChangeSchema),
  })
  .strict();

export const baseCommitSchema = z
  .object({
    commitId: z.string(),
    message: z.string(),
    authorName: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const upstreamSchema = z
  .object({
    behind: z.number().int().nonnegative(),
    /** When GitButler last fetched the target, as an ISO time. Null before the first fetch. */
    lastFetched: z.string().nullable(),
    /** The target's newest commit, with the first line of its message. */
    latest: z.object({ commitId: z.string(), subject: z.string() }).strict().nullable(),
  })
  .strict();

/** Why the panel has nothing to show. `ready` is the only usable state. */
export const workspaceStateSchema = z.enum([
  "ready",
  "noEnvironment",
  "noRepository",
  "cliMissing",
  "setupRequired",
  "error",
]);

export const workspaceSchema = z
  .object({
    state: workspaceStateSchema,
    reason: z.string().nullable(),
    /**
     * The thread's environment, so a panel can tell which workspace-changed
     * signals are about it. Null when the thread has no usable environment.
     */
    environmentId: z.string().nullable(),
    /** The repository the host read, "." for the root. Null when it found none. */
    repositoryKey: z.string().nullable(),
    repoName: z.string(),
    unassignedChanges: z.array(fileChangeSchema),
    stacks: z.array(stackSchema),
    base: baseCommitSchema.nullable(),
    upstream: upstreamSchema.nullable(),
    /**
     * Uncommitted files holding conflict markers, which `but status` lists
     * apart from the other changes. A pull or delete can leave them behind.
     */
    conflictedFiles: z.array(z.string()),
  })
  .strict();

/** What the host reads. The server knows the environment and adds it. */
export const hostWorkspaceSchema = workspaceSchema.omit({ environmentId: true });

export const repositorySchema = z.object({ key: z.string(), name: z.string() }).strict();

export const repositoriesSchema = z
  .object({ repositories: z.array(repositorySchema), reason: z.string().nullable() })
  .strict();

export const baseHistorySchema = z
  .object({
    commits: z.array(baseCommitSchema),
    hasMore: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();

/**
 * Uncommitted work has no commit id; a commit patch names one. `where` marks
 * a commit the panel knows is on the target, the common base or a commit
 * above it, which `but diff` cannot resolve, so the host goes straight to git.
 */
export const patchSourceSchema = z.union([
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z
    .object({
      kind: z.literal("commit"),
      commitId: commitIdSchema,
      where: z.enum(["base", "upstream"]).optional(),
    })
    .strict(),
]);

/** One file of a `but diff` payload: a complete git patch Pierre can parse. */
export const filePatchSchema = z
  .object({
    path: z.string(),
    kind: changeKindSchema,
    /** The old path of a renamed file. Null when the path did not change. */
    previousPath: z.string().nullable(),
    patch: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const patchesSchema = z
  .object({ files: z.array(filePatchSchema), truncated: z.boolean() })
  .strict();

/**
 * A branch name as an argv value. No whitespace, and no leading dash, so `but`
 * can never read it as a flag. No leading `refs/` either: `but` reads
 * `refs/heads/topic` as the full name of `topic`, another branch. Git applies
 * its own ref rules after that.
 */
export const branchNameSchema = z
  .string()
  .min(1)
  .max(255, "A branch name can be at most 255 characters.")
  .regex(/^[^\s-]\S*$/, "A branch name cannot start with a dash or contain whitespace.")
  .refine((name) => !name.startsWith("refs/"), "A branch name cannot start with refs/.");

/**
 * What a write would do beyond its own job, which the reader accepts before
 * it runs: leave commits in these branches conflicted, or write conflict
 * markers into uncommitted files.
 */
export const actionRiskSchema = z
  .object({ conflicted: z.array(z.string()), overlapsUncommitted: z.boolean() })
  .strict();

/**
 * Every `but` write the panel runs: the branch-card buttons, each on one named
 * branch, and the header's Pull for the whole workspace. Pull, Update, and
 * Delete check for risks first. `accepted` is the risk the reader agreed to,
 * so a retry that finds anything more asks again.
 */
export const butActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("push"),
      branch: branchNameSchema,
      force: z.boolean(),
      /**
       * The upstream commits the reader agreed this push deletes, by id: none
       * when they were not asked. Ids, not a count, so a remote rewritten in
       * the meantime asks again.
       */
      acceptedLoss: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("land"),
      branch: branchNameSchema,
      /**
       * The message of the one commit a branch of several is squashed into
       * before it lands. Null for a branch of one commit, which lands as is.
       */
      message: z
        .string()
        .max(20_000, "A commit message can be at most 20,000 characters.")
        .regex(/\S/, "Write a commit message.")
        .nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("rename"), branch: branchNameSchema, name: branchNameSchema })
    .strict(),
  z
    .object({
      kind: z.literal("pull"),
      branch: branchNameSchema,
      accepted: actionRiskSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      branch: branchNameSchema,
      accepted: actionRiskSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("updateWorkspace"), accepted: actionRiskSchema.nullable() }).strict(),
]);

/** How a write ended. `confirm` means nothing ran yet: the reader is asked about `risk` first. */
export const butActionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done") }).strict(),
  z.object({ status: z.literal("upToDate") }).strict(),
  z.object({ status: z.literal("confirm"), risk: actionRiskSchema }).strict(),
]);

/** Where a branch's review lives on its forge, or null when it has none. */
export const reviewUrlSchema = z.object({ url: z.string().nullable() }).strict();

/**
 * Where a branch's review stands on its forge. `but` 0.22.3 lists open reviews
 * only and does not say which are drafts, so its answers are open, or draft
 * when a record says so. Merged and closed are for a CLI that reports them.
 */
export const reviewStateSchema = z.enum(["open", "draft", "merged", "closed"]);

export const branchReviewSchema = z
  .object({
    branch: z.string(),
    number: z.number().int().nonnegative(),
    state: reviewStateSchema,
    url: z.string().nullable(),
  })
  .strict();

/**
 * Every local branch's review, read apart from the workspace because it can
 * ask the forge. Without a forge account `but` answers from its own cache,
 * which can miss reviews opened elsewhere.
 */
export const reviewsSchema = z
  .object({ reviews: z.array(branchReviewSchema), reason: z.string().nullable() })
  .strict();

/** One entry of GitButler's operation log, newest first, which restores read by `id`. */
export const oplogEntrySchema = z
  .object({
    id: z.string(),
    /** GitButler's name for the kind of write, as in "CreateCommit". */
    operation: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export const oplogSchema = z
  .object({ entries: z.array(oplogEntrySchema), reason: z.string().nullable() })
  .strict();

/** A local branch that is not applied to the workspace. */
export const parkedBranchSchema = z
  .object({
    name: z.string(),
    /** Its head commit's subject. Null when git could not read it. */
    subject: z.string().nullable(),
    /** When its head commit was made, as an ISO time. */
    updatedAt: z.string().nullable(),
  })
  .strict();

/** `but` lists the 20 most recently updated, and `hasMore` says it left some out. */
export const parkedBranchesSchema = z
  .object({
    branches: z.array(parkedBranchSchema),
    hasMore: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();

/** The repository a possibly omitted key means, as the host found it. */
export const resolvedRepositorySchema = z.object({ key: z.string(), path: z.string() }).strict();

/** A Create PR subthread the panel started, and whether its agent is still at work. */
export const reviewRequestSchema = z
  .object({ branch: z.string(), threadId: z.string(), running: z.boolean() })
  .strict();

export const reviewRequestsSchema = z.object({ requests: z.array(reviewRequestSchema) }).strict();

/** A subthread the panel started, and whether its agent is still at work. */
export const subthreadSchema = z.object({ threadId: z.string(), running: z.boolean() }).strict();

/** The repository's Resolve conflicts subthread, or null when it has none still around. */
export const conflictResolutionSchema = z
  .object({ subthread: subthreadSchema.nullable() })
  .strict();

export type ChangeKind = z.infer<typeof changeKindSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type Commit = z.infer<typeof commitSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type Stack = z.infer<typeof stackSchema>;
export type BaseCommit = z.infer<typeof baseCommitSchema>;
export type Upstream = z.infer<typeof upstreamSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type HostWorkspace = z.infer<typeof hostWorkspaceSchema>;
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type PatchSource = z.infer<typeof patchSourceSchema>;
export type FilePatch = z.infer<typeof filePatchSchema>;
export type Patches = z.infer<typeof patchesSchema>;
export type BranchStatus = z.infer<typeof branchStatusSchema>;
export type PushMode = z.infer<typeof pushModeSchema>;
export type ButAction = z.infer<typeof butActionSchema>;
export type ButActionResult = z.infer<typeof butActionResultSchema>;
export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type Subthread = z.infer<typeof subthreadSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;
export type BranchReview = z.infer<typeof branchReviewSchema>;
export type Reviews = z.infer<typeof reviewsSchema>;
export type OplogEntry = z.infer<typeof oplogEntrySchema>;
export type Oplog = z.infer<typeof oplogSchema>;
export type ParkedBranch = z.infer<typeof parkedBranchSchema>;
export type ParkedBranches = z.infer<typeof parkedBranchesSchema>;
