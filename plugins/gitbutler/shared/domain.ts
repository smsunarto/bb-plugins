import { z } from "zod";

export const GITBUTLER_VERSION = "0.22.3" as const;

export const threadIdSchema = z.string().trim().min(1).max(255);
export const environmentIdSchema = z.string().trim().min(1).max(255);
export const repositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), {
    message: "repository path must be absolute",
  });

export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\0") &&
      !value
        .split(/[\\/]/u)
        .some((segment) => segment === "" || segment === "." || segment === ".."),
    { message: "path must be repository-relative" },
  );

export function isValidBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 255 || value === "@") return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  for (const character of value) {
    const codeUnit = character.charCodeAt(0);
    if (codeUnit <= 0x20 || codeUnit === 0x7f || "~^:?*[\\".includes(character)) return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

export const branchNameSchema = z
  .string()
  .trim()
  .refine(isValidBranchName, { message: "invalid Git branch name" });
export const hunkRevisionKeySchema = z.string().regex(/^h1:[a-f0-9]{64}$/u);
export const commitMessageSchema = z.string().trim().min(1).max(10_000);

export const branchTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), branchName: branchNameSchema }).strict(),
  z.object({ kind: z.literal("new"), branchName: branchNameSchema }).strict(),
]);

export const commitIntentSchema = z
  .object({
    message: commitMessageSchema,
    target: branchTargetSchema,
    hunkKeys: z.array(hunkRevisionKeySchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.hunkKeys).size !== value.hunkKeys.length) {
      context.addIssue({
        code: "custom",
        message: "hunk revision keys must be unique",
        path: ["hunkKeys"],
      });
    }
  });

export type CommitIntent = z.infer<typeof commitIntentSchema>;
export type HunkRevisionKey = z.infer<typeof hunkRevisionKeySchema>;

export const changeKindSchema = z.enum(["added", "modified", "deleted", "renamed", "unknown"]);
export const changedFileSchema = z
  .object({ path: repositoryRelativePathSchema, kind: changeKindSchema })
  .strict();

export const commitSummarySchema = z
  .object({ commitId: z.string().min(1), message: z.string() })
  .strict();

export const commitViewSchema = commitSummarySchema
  .extend({
    changeId: z.string().min(1),
    createdAt: z.string(),
    author: z.object({ name: z.string(), email: z.string() }).strict(),
    conflicted: z.boolean(),
    reviewId: z.string().nullable(),
    files: z.array(changedFileSchema),
  })
  .strict();

export const ciViewSchema = z
  .object({
    status: z.string(),
    conclusion: z.string(),
    pendingChecks: z.array(z.string()),
    passingChecks: z.array(z.string()),
    failingChecks: z.array(z.string()),
  })
  .strict();

export const branchViewSchema = z
  .object({
    rowKey: z.string().min(1),
    branchName: branchNameSchema,
    status: z.object({ code: z.string(), label: z.string() }).strict(),
    reviewId: z.string().nullable(),
    ci: ciViewSchema.nullable(),
    commits: z.array(commitViewSchema),
    upstreamCommits: z.array(commitViewSchema),
  })
  .strict();

export const stackViewSchema = z
  .object({
    rowKey: z.string().min(1),
    assignedFiles: z.array(changedFileSchema),
    branches: z.array(branchViewSchema),
  })
  .strict();

export const worktreeHunkSchema = z
  .object({
    revisionKey: hunkRevisionKeySchema,
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    patch: z.string().min(1),
  })
  .strict();

export const worktreeFileSchema = changedFileSchema
  .extend({
    content: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), hunks: z.array(worktreeHunkSchema).min(1) }).strict(),
      z
        .object({
          kind: z.literal("unselectable"),
          reason: z.enum(["binary", "unsupported-diff", "missing-diff"]),
        })
        .strict(),
    ]),
  })
  .strict();

export const worktreeViewSchema = z
  .object({ files: z.array(worktreeFileSchema), hunkCount: z.number().int().nonnegative() })
  .strict();

export const hostRepositorySnapshotSchema = z
  .object({
    gitButlerVersion: z.literal(GITBUTLER_VERSION),
    capturedAt: z.number().int().nonnegative(),
    mergeBase: commitSummarySchema.nullable(),
    upstream: z
      .object({ behind: z.number().int().nonnegative(), lastFetched: z.string().nullable() })
      .strict(),
    stacks: z.array(stackViewSchema),
    worktree: worktreeViewSchema,
  })
  .strict();

export const repositorySnapshotSchema = hostRepositorySnapshotSchema
  .extend({ environmentId: environmentIdSchema })
  .strict();

export const repositoryIssueCodeSchema = z.enum([
  "thread-unavailable",
  "no-environment",
  "environment-not-ready",
  "not-git-repository",
  "linked-worktree",
  "workspace-path-missing",
  "host-unreachable",
  "gitbutler-not-installed",
  "not-gitbutler-project",
  "unsupported-gitbutler-version",
  "invalid-gitbutler-output",
  "output-limit",
  "repository-changing",
]);

export const repositoryIssueSchema = z
  .object({ code: repositoryIssueCodeSchema, message: z.string().min(1) })
  .strict();

export const repositoryStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), issue: repositoryIssueSchema }).strict(),
  z.object({ kind: z.literal("ready"), repository: repositorySnapshotSchema }).strict(),
]);

export const commitOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("committed"),
      branchName: branchNameSchema,
      commitId: z.string().min(1),
      committedHunkCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      code: z.enum([
        "repository-unavailable",
        "thread-active",
        "selection-stale",
        "target-stale",
        "branch-name-taken",
        "gitbutler-rejected",
      ]),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("uncertain"),
      code: z.enum([
        "timeout",
        "cancelled",
        "output-limit",
        "host-call-failed",
        "postcondition-failed",
      ]),
      message: z.string().min(1),
    })
    .strict(),
]);

export const repositoryOutputSchema = z.object({ repository: repositoryStateSchema }).strict();
export const commitSelectionOutputSchema = z
  .object({ outcome: commitOutcomeSchema, repository: repositoryStateSchema.nullable() })
  .strict();

export type ChangedFile = z.infer<typeof changedFileSchema>;
export type HostRepositorySnapshot = z.infer<typeof hostRepositorySnapshotSchema>;
export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;
export type RepositoryState = z.infer<typeof repositoryStateSchema>;
export type CommitOutcome = z.infer<typeof commitOutcomeSchema>;
