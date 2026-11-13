/**
 * The server ↔ host contract. Reads are retryable; writes (`vcsAction`) are
 * not. The forge call carries a closed union of operations, never an argv
 * proxy. The host says unasked when a watched checkout changed.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  commitSchema,
  forgeReadSchema,
  forgeResultSchema,
  patchesSchema,
  patchSourceSchema,
  revisionSchema,
  vcsActionSchema,
  vcsResultSchema,
  workspaceValueSchema,
} from "../core/change.ts";
import { LOG_CHARS, MAX_LOGS, MISSING_CHARS } from "../core/fix-checks.ts";
import { repoSchema } from "../core/ids.ts";
import { mergeMethodSchema, mergePolicySchema } from "../core/merge.ts";
import { oplogSchema } from "../core/oplog.ts";
import { MAX_PR_REFS, prStatusSchema } from "../core/pr-reads.ts";
import {
  BASE_HISTORY_MAX,
  baseHistorySchema,
  commitIdSchema as baseIdSchema,
} from "../core/history.ts";
import { timelineItemSchema } from "../core/items.ts";
import { changeFileSchema, forgeFileSchema, inboxEntrySchema } from "../core/review.ts";
import {
  baseBranchSchema,
  checkoutFilesSchema,
  checkoutPatchesSchema,
  checkoutPatchFilesSchema,
  checkoutStatusSchema,
  checkoutTargetSchema,
} from "../core/checkout-reads.ts";
import {
  commitRefSchema,
  landedSchema,
  MAX_LANDED,
  prHeadSchema,
  prRefSchema,
  watchReadSchema,
} from "../core/watch.ts";

const pathSchema = z.string().min(1).max(4096);
/** A commit id (four characters or more), or its first parent as `<id>^` for one commit's own diff. */
const commitIdSchema = z.string().regex(/^[0-9a-fA-F]{4,64}\^?$/);
/**
 * A range's base: a commit id, or `branch:<name>` for that branch on the
 * checkout's remote (`branch:` alone: the remote's default branch), which
 * the host resolves when no target was read.
 */
const baseSchema = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{4,64}\^?|branch:(?:[A-Za-z0-9_][A-Za-z0-9._/-]{0,250})?)$/)
  .refine((base) => !base.includes(".."), "A branch name has no '..'.");

/** How to read a checkout: by what it is, or as plain git whatever it is. */
export const readAsSchema = z.enum(["auto", "git"]);
export type ReadAs = z.infer<typeof readAsSchema>;

export const hostWorkspaceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("workspace"), value: workspaceValueSchema }).strict(),
  /** A plain checkout with no branch checked out (detached HEAD, or mid-rebase). */
  z.object({ state: z.literal("detached"), path: z.string() }).strict(),
  z.object({ state: z.literal("not-git"), path: z.string() }).strict(),
]);
export type HostWorkspace = z.infer<typeof hostWorkspaceSchema>;

/** A failure the server turns into a facet problem. */
export const hostFailureSchema = z
  .object({
    code: z.enum([
      "git-missing",
      /** The checkout is a GitButler workspace and `but` is not on this host. */
      "but-missing",
      "gh-missing",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "forbidden",
      "failed",
    ]),
    message: z.string(),
  })
  .strict();
export type HostFailure = z.infer<typeof hostFailureSchema>;

function outcome<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: hostFailureSchema }).strict(),
  ]);
}

/**
 * Which signed-in `gh` account runs a forge call: `active` is the one `gh`
 * uses by default; another runs with its own token. Null: the active one.
 */
export const forgeAccountSchema = z
  .object({ login: z.string().min(1), active: z.boolean() })
  .strict()
  .nullable();
export type ForgeAccount = z.infer<typeof forgeAccountSchema>;

const pullRequestQuery = {
  repo: repoSchema,
  headOwner: z.string().min(1),
  branch: z.string().min(1),
  account: forgeAccountSchema,
};

export const forgeOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pr.read"), ...pullRequestQuery }).strict(),
]);
export type ForgeOperation = z.infer<typeof forgeOperationSchema>;

/** The review page's GitHub reads a host runs as one of its accounts. */
export const reviewReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox"), pins: z.array(prRefSchema).max(50).optional() }).strict(),
  z
    .object({ kind: z.literal("files"), repo: repoSchema, number: z.number().int().positive() })
    .strict(),
  z
    .object({ kind: z.literal("commits"), repo: repoSchema, number: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal("compare"),
      repo: repoSchema,
      base: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
      head: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
    })
    .strict(),
  z
    .object({ kind: z.literal("timeline"), repo: repoSchema, number: z.number().int().positive() })
    .strict(),
  /** A watched pull request: its state, checks, and what others said. */
  z.object({ kind: z.literal("watch"), ref: prRefSchema }).strict(),
  /** The branch a pull request comes from. */
  z.object({ kind: z.literal("prHead"), ref: prRefSchema }).strict(),
  /** What merging a pull request needs: its state, the merge methods allowed, and this account's permission. */
  z
    .object({
      kind: z.literal("mergePolicy"),
      repo: repoSchema,
      number: z.number().int().positive(),
    })
    .strict(),
  /** Whether listed pull requests merged and commits reached their default branch. */
  z
    .object({
      kind: z.literal("landed"),
      prs: z.array(prRefSchema).max(MAX_LANDED),
      commits: z.array(commitRefSchema).max(MAX_LANDED),
    })
    .strict(),
  /** The end of failed Actions jobs' logs, for the Fix checks prompt. */
  z
    .object({
      kind: z.literal("jobLogs"),
      repo: repoSchema,
      jobIds: z.array(z.number().int().positive()).min(1).max(MAX_LOGS),
    })
    .strict(),
  /** Several pull requests of one repository by number: GenUI's PullRequest(refs). */
  z
    .object({
      kind: z.literal("prStatuses"),
      repo: repoSchema,
      numbers: z.array(z.number().int().positive()).min(1).max(MAX_PR_REFS),
    })
    .strict(),
]);

export const reviewAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox"), entries: z.array(inboxEntrySchema).max(250) }).strict(),
  z.object({ kind: z.literal("files"), files: z.array(forgeFileSchema).max(3_000) }).strict(),
  z.object({ kind: z.literal("commits"), commits: z.array(commitSchema).max(1_000) }).strict(),
  z.object({ kind: z.literal("timeline"), items: z.array(timelineItemSchema).max(100) }).strict(),
  z.object({ kind: z.literal("watch"), read: watchReadSchema }).strict(),
  z.object({ kind: z.literal("landed"), landed: landedSchema }).strict(),
  z.object({ kind: z.literal("prHead"), head: prHeadSchema }).strict(),
  z.object({ kind: z.literal("mergePolicy"), policy: mergePolicySchema }).strict(),
  z
    .object({
      kind: z.literal("jobLogs"),
      logs: z
        .array(
          z
            .object({
              jobId: z.number().int().positive(),
              text: z.string().max(LOG_CHARS).nullable(),
              missing: z.string().max(MISSING_CHARS).nullable(),
            })
            .strict(),
        )
        .max(MAX_LOGS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prStatuses"),
      statuses: z
        .array(
          z
            .object({ number: z.number().int().positive(), status: prStatusSchema.nullable() })
            .strict(),
        )
        .max(MAX_PR_REFS),
    })
    .strict(),
]);

export const reviewSubmittedSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), url: z.string().nullable() }).strict(),
  z.object({ status: z.literal("upToDate"), url: z.string().nullable() }).strict(),
  z.object({ status: z.literal("conflict"), detail: z.string() }).strict(),
]);

/** How long a write may run on the host. */
export const ACTION_DEADLINE_MS = 5 * 60_000;

export const sourceControlHostContract = defineRpcContract({
  /**
   * The checkout's workspace. Reading it keeps the checkout watched for
   * `WATCH_LEASE_MS`, so the host signals the next change instead of being polled.
   */
  workspace: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema, readAs: readAsSchema }).strict(),
    output: outcome(hostWorkspaceSchema),
  },
  /** File patches of uncommitted work or one commit. */
  patches: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema, readAs: readAsSchema, source: patchSourceSchema }).strict(),
    output: outcome(patchesSchema),
  },
  /**
   * The checkout's files, patches or commits between two commits: what
   * `head` adds since it left `base`. Immutable for a pair of commits.
   */
  range: {
    experimental_retryable: true,
    input: z
      .object({
        path: pathSchema,
        base: baseSchema,
        head: commitIdSchema,
        read: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("files") }).strict(),
          z
            .object({ kind: z.literal("patches"), paths: z.array(z.string()).min(1).max(80) })
            .strict(),
          z.object({ kind: z.literal("commits") }).strict(),
        ]),
      })
      .strict(),
    output: outcome(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("files"), files: z.array(changeFileSchema) }).strict(),
        z.object({ kind: z.literal("patches"), files: patchesSchema.shape.files }).strict(),
        z.object({ kind: z.literal("commits"), commits: z.array(commitSchema) }).strict(),
      ]),
    ),
  },
  /** The checkout as plain git sees it, measured against `base` (null: its default branch). For other plugins. */
  checkoutStatus: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema, base: baseBranchSchema.nullable() }).strict(),
    output: outcome(checkoutStatusSchema),
  },
  /** A target's changed files, with the first ones' patches. For other plugins. */
  checkoutFiles: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema, target: checkoutTargetSchema }).strict(),
    output: outcome(checkoutFilesSchema),
  },
  /** Patches of some of a target's files. For other plugins. */
  checkoutPatches: {
    experimental_retryable: true,
    input: z
      .object({ path: pathSchema, target: checkoutTargetSchema, files: checkoutPatchFilesSchema })
      .strict(),
    output: outcome(checkoutPatchesSchema),
  },
  /** GitButler's recent operations on the checkout, newest first; none for a plain git one. */
  oplog: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema }).strict(),
    output: outcome(oplogSchema),
  },
  /** The target's commits under the common base `from`, newest first, `from` itself excluded. */
  baseHistory: {
    experimental_retryable: true,
    input: z
      .object({
        path: pathSchema,
        from: baseIdSchema,
        limit: z.number().int().min(1).max(BASE_HISTORY_MAX),
      })
      .strict(),
    output: outcome(baseHistorySchema),
  },
  /** Keeps a checkout watched for another lease without reading it. */
  renewWatch: {
    experimental_retryable: true,
    input: z.object({ path: pathSchema }).strict(),
    output: z.object({ watching: z.boolean() }).strict(),
  },
  /**
   * One write on the checkout, made only if it is still at `expected`.
   * Never retried: a transport failure leaves the outcome unknown.
   */
  vcsAction: {
    input: z
      .object({
        path: pathSchema,
        readAs: readAsSchema,
        action: vcsActionSchema,
        expected: revisionSchema,
      })
      .strict(),
    output: vcsResultSchema,
  },
  forgeAccounts: {
    experimental_retryable: true,
    input: z.object({}).strict(),
    output: outcome(z.object({ accounts: z.array(z.string()) }).strict()),
  },
  forgeCall: {
    experimental_retryable: true,
    input: forgeOperationSchema,
    output: outcome(forgeReadSchema),
  },
  /** An inbox, or a pull request's files or commits, read on this host as `account`. */
  forgeReview: {
    experimental_retryable: true,
    input: z.object({ read: reviewReadSchema, account: forgeAccountSchema }).strict(),
    output: outcome(reviewAnswerSchema),
  },
  /**
   * Marks the pull request draft or ready while its head is still
   * `expectedHead`. Convergent, so it may be retried.
   */
  forgeWrite: {
    experimental_retryable: true,
    input: z
      .object({
        op: z.literal("pr.setDraft"),
        ...pullRequestQuery,
        number: z.number().int().positive(),
        draft: z.boolean(),
        expectedHead: z.string().min(1),
      })
      .strict(),
    output: outcome(forgeResultSchema),
  },
  /**
   * Merges the pull request only while it is still at `expectedHead` into
   * `expectedBase`. Never retried: a transport failure leaves the outcome
   * unknown, and the reader reads the pull request again.
   */
  forgeMerge: {
    input: z
      .object({
        repo: repoSchema,
        number: z.number().int().positive(),
        method: mergeMethodSchema,
        expectedHead: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
        expectedBase: z.string().min(1),
        account: forgeAccountSchema,
      })
      .strict(),
    output: outcome(forgeResultSchema),
  },
  /**
   * Posts one review carrying every comment, only while the pull request is
   * still at `expectedHead`. Convergent: a review already carrying `marker`
   * is returned as `upToDate`, so it may be retried.
   */
  forgeSubmitReview: {
    experimental_retryable: true,
    input: z
      .object({
        ...pullRequestQuery,
        number: z.number().int().positive(),
        expectedHead: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
        marker: z.string().regex(/^<!-- source-control:batch=[A-Za-z0-9_-]{1,128} -->$/),
        body: z.string().max(65_536),
        comments: z
          .array(
            z
              .object({
                path: pathSchema,
                line: z.number().int().positive(),
                startLine: z.number().int().positive().nullable(),
                side: z.enum(["LEFT", "RIGHT"]),
                body: z.string().max(65_536),
              })
              .strict(),
          )
          .max(200),
      })
      .strict(),
    output: outcome(reviewSubmittedSchema),
  },
});

export type RangeRead = z.infer<typeof sourceControlHostContract.range.input>["read"];
export type RangeAnswer = Extract<
  z.infer<typeof sourceControlHostContract.range.output>,
  { ok: true }
>["value"];

/** How long one read or renewal keeps a checkout watched. */
export const WATCH_LEASE_MS = 150_000;

/**
 * What the host says unasked: a watched checkout changed on disk (a file in
 * its working tree, its index or HEAD, a ref, or GitButler's own state), by
 * anything but this plugin's own reads.
 */
export const sourceControlHostSignals = {
  checkoutChanged: {
    /** Each checkout as the server named it in `workspace` or `renewWatch`. */
    payload: z.object({ paths: z.array(pathSchema).min(1).max(1_000) }).strict(),
  },
} as const;
