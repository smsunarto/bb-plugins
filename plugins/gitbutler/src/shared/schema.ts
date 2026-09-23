import { z } from "zod";

/**
 * The wire model. `but --json` is the only source for workspace shape, so
 * every field here is something the CLI already knows; the host narrows the
 * CLI's freeform strings to these unions and never invents a value.
 */

export const environmentPathSchema = z.string().min(1).max(16_384);
/** Relative to the environment root, or "." for the root repository itself. */
export const repositoryKeySchema = z.string().min(1).max(1024);
export const filePathSchema = z.string().min(1).max(16_384);
export const commitIdSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/);

export const changeKindSchema = z.enum(["added", "modified", "deleted", "renamed", "copied"]);

export const fileChangeSchema = z.object({ path: z.string(), kind: changeKindSchema }).strict();

export const commitSchema = z
  .object({
    commitId: z.string(),
    changeId: z.string().nullable(),
    message: z.string(),
    authorName: z.string(),
    authorEmail: z.string(),
    createdAt: z.string(),
    conflicted: z.boolean(),
    reviewId: z.string().nullable(),
  })
  .strict();

/** What `but show` adds on top of a list row: the body and the file list. */
export const commitDetailsSchema = z
  .object({
    commitId: z.string(),
    message: z.string(),
    authorName: z.string(),
    authorEmail: z.string(),
    files: z.array(fileChangeSchema),
  })
  .strict();

/** GitButler's push status for a branch head, plus the raw CLI string. */
export const branchStatusSchema = z.enum([
  "unpushed",
  "pushed",
  "diverged",
  "integrated",
  "conflicted",
  "empty",
  "unknown",
]);

export const branchSchema = z
  .object({
    name: z.string(),
    status: branchStatusSchema,
    rawStatus: z.string(),
    reviewId: z.string().nullable(),
    ci: z.string().nullable(),
    commits: z.array(commitSchema),
    upstreamCommits: z.array(commitSchema),
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
    latestCommitId: z.string().nullable(),
    lastFetched: z.string().nullable(),
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
    repoName: z.string(),
    unassignedChanges: z.array(fileChangeSchema),
    stacks: z.array(stackSchema),
    base: baseCommitSchema.nullable(),
    upstream: upstreamSchema.nullable(),
    /** Changes whenever anything above does, so polling can skip re-renders. */
    revision: z.string(),
  })
  .strict();

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

/** Uncommitted work has no commit id; a commit patch names one. */
export const patchSourceSchema = z.union([
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z.object({ kind: z.literal("commit"), commitId: commitIdSchema }).strict(),
]);

export const patchSchema = z
  .object({ path: z.string(), patch: z.string(), truncated: z.boolean() })
  .strict();

export type FileChange = z.infer<typeof fileChangeSchema>;
export type Commit = z.infer<typeof commitSchema>;
export type CommitDetails = z.infer<typeof commitDetailsSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type Stack = z.infer<typeof stackSchema>;
export type BaseCommit = z.infer<typeof baseCommitSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type PatchSource = z.infer<typeof patchSourceSchema>;
export type Patch = z.infer<typeof patchSchema>;
export type BranchStatus = z.infer<typeof branchStatusSchema>;
