/**
 * Plain-git reads of one environment's checkout for other plugins: what is
 * checked out, how far it is from its base branch, and the files and
 * patches of its uncommitted work, its branch, or one commit. GenUI's
 * Changes, Commits and Environments read these in place of bb's bundled Git
 * plugin, so bb--git can stay disabled.
 */
import { z } from "zod";
import { fileChangeSchema, filePatchSchema } from "./change.ts";

/** Most changed files one read lists. */
export const MAX_CHECKOUT_FILES = 1000;
/** Most commits a status lists. */
export const MAX_CHECKOUT_COMMITS = 500;
/** Most files one patches read asks for. */
export const MAX_PATCH_PATHS = 25;

const shaSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/);

/** A branch name as bb stores an environment's base: no option, range, or ref prefix. */
export const baseBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
  .refine((name) => !name.includes("..") && !name.startsWith("refs/"));

/** What a diff compares: the uncommitted work, the branch's work since `base`, or one commit. */
export const checkoutTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  /** Everything in the working tree since it left `base`, uncommitted work included. */
  z.object({ kind: z.literal("branch"), base: baseBranchSchema }).strict(),
  z.object({ kind: z.literal("commit"), sha: shaSchema }).strict(),
]);
export type CheckoutTarget = z.infer<typeof checkoutTargetSchema>;

export const checkoutFileSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().nullable(),
    kind: fileChangeSchema.shape.kind,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    /** Not in the index yet: git status's `??`. */
    untracked: z.boolean(),
  })
  .strict();
export type CheckoutFile = z.infer<typeof checkoutFileSchema>;

export const checkoutCommitSchema = z
  .object({
    sha: z.string(),
    subject: z.string(),
    author: z.string(),
    /** Author time, ms since the epoch. */
    authoredAt: z.number(),
  })
  .strict();
export type CheckoutCommit = z.infer<typeof checkoutCommitSchema>;

export const checkoutHeadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string(), sha: z.string() }).strict(),
  z.object({ kind: z.literal("detached"), sha: z.string() }).strict(),
  /** A branch with no commit yet. */
  z.object({ kind: z.literal("unborn"), name: z.string().nullable() }).strict(),
]);
export type CheckoutHead = z.infer<typeof checkoutHeadSchema>;

export const checkoutStatusSchema = z.discriminatedUnion("state", [
  /** The workspace folder no longer exists. */
  z.object({ state: z.literal("missing") }).strict(),
  z.object({ state: z.literal("not-git") }).strict(),
  z
    .object({
      state: z.literal("read"),
      head: checkoutHeadSchema,
      /** The remote's default branch, else `main` or `master` where one exists. */
      defaultBranch: z.string().nullable(),
      /** The branch the status is measured against: the one asked for, else the default. */
      base: z.string().nullable(),
      uncommitted: z
        .object({
          files: z.number().int().nonnegative(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
        })
        .strict(),
      /** Null when there is no base to compare with, or no commit yet. */
      mergeBase: z
        .object({
          ahead: z.number().int().nonnegative(),
          behind: z.number().int().nonnegative(),
          /** The branch's own commits, newest first. */
          commits: z.array(checkoutCommitSchema).max(MAX_CHECKOUT_COMMITS),
        })
        .strict()
        .nullable(),
    })
    .strict(),
]);
export type CheckoutStatus = z.infer<typeof checkoutStatusSchema>;

export const checkoutFilesSchema = z
  .object({
    files: z.array(checkoutFileSchema).max(MAX_CHECKOUT_FILES),
    /** More files changed than are listed. */
    truncated: z.boolean(),
    /** Patches of the first files, while they fit the read's budget. */
    patches: z.array(filePatchSchema),
  })
  .strict();
export type CheckoutFiles = z.infer<typeof checkoutFilesSchema>;

export const checkoutPatchesSchema = z.object({ patches: z.array(filePatchSchema) }).strict();
export type CheckoutPatches = z.infer<typeof checkoutPatchesSchema>;

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0"),
    "A path inside the repository.",
  );

/** Files whose patches to read, each with its old path when it was renamed, as the file list gave it. */
export const checkoutPatchFilesSchema = z
  .array(
    z
      .object({ path: repositoryPathSchema, previousPath: repositoryPathSchema.nullable() })
      .strict(),
  )
  .min(1)
  .max(MAX_PATCH_PATHS);
export type CheckoutPatchFile = z.infer<typeof checkoutPatchFilesSchema>[number];
