/**
 * The pull request of a thread's GitButler branch. Forked from bb's bundled
 * GitHub PR Status plugin (`bb--github-pr-status`), whose rows are keyed by
 * environment and so read `gitbutler/workspace` in a GitButler checkout. These
 * rows are keyed by thread and keep the bundled plugin's shape, so a reader of
 * one reads the other.
 */
import { z } from "zod";

const checkStatusSchema = z.enum(["queued", "in_progress", "completed", "unknown"]);

const checkConclusionSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
  "unknown",
]);

const checkSchema = z
  .object({
    name: z.string().min(1),
    status: checkStatusSchema,
    conclusion: checkConclusionSchema.nullable(),
    /** A re-run of a check repeats its name; the latest start wins. */
    startedAt: z.string().nullable(),
  })
  .strict();
export type GitHubPullRequestCheck = z.infer<typeof checkSchema>;

const reviewDecisionSchema = z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);

const mergeStateStatusSchema = z.enum([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);

const mergeableSchema = z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]);

/** What `gh pr view --json` says about one pull request, normalized on the host. */
export const gitHubPullRequestViewSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    url: z.url(),
    isDraft: z.boolean(),
    autoMerge: z.boolean(),
    baseRefName: z.string(),
    headRefName: z.string(),
    /** The head commit, which a merge must still find there. */
    headRefOid: z.string().nullable(),
    updatedAt: z.string(),
    checks: z.array(checkSchema).max(1_000),
    reviewDecision: reviewDecisionSchema.nullable(),
    reviewRequestCount: z.number().int().nonnegative(),
    mergeStateStatus: mergeStateStatusSchema.nullable(),
    mergeable: mergeableSchema.nullable(),
  })
  .strict();
export type GitHubPullRequestView = z.infer<typeof gitHubPullRequestViewSchema>;

const pullRequestStateSchema = z.enum(["draft", "open", "merged", "closed"]);
export type PullRequestState = z.infer<typeof pullRequestStateSchema>;

const checksSchema = z
  .object({
    state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
    totalCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
  })
  .strict();
export type PullRequestChecks = z.infer<typeof checksSchema>;

const reviewSchema = z
  .object({
    state: z.enum(["approved", "changes_requested", "review_required", "review_requested", "none"]),
    reviewRequestCount: z.number().int().nonnegative(),
  })
  .strict();
export type PullRequestReview = z.infer<typeof reviewSchema>;

const mergeabilitySchema = z
  .object({
    state: z.enum(["mergeable", "conflicts", "blocked", "draft", "unknown"]),
    mergeStateStatus: mergeStateStatusSchema.nullable(),
    mergeable: mergeableSchema.nullable(),
  })
  .strict();
export type PullRequestMergeability = z.infer<typeof mergeabilitySchema>;

const attentionSchema = z.enum([
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
]);
export type PullRequestAttentionState = z.infer<typeof attentionSchema>;

export const pullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: pullRequestStateSchema,
    url: z.url(),
    baseRefName: z.string(),
    headRefName: z.string(),
    headRefOid: z.string().nullable(),
    updatedAt: z.string(),
    autoMerge: z.boolean(),
    /** `gh pr view` does not report merge queues; kept for the bundled plugin's shape. */
    inMergeQueue: z.null(),
    checks: checksSchema,
    review: reviewSchema,
    mergeability: mergeabilitySchema,
    attention: attentionSchema,
  })
  .strict();
export type PullRequest = z.infer<typeof pullRequestSchema>;

/**
 * One thread's row. `absent` covers a thread outside a GitButler workspace,
 * one with no branch of its own, and a branch with no pull request.
 */
export const threadPullRequestSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), pullRequest: pullRequestSchema }).strict(),
  z.object({ outcome: z.literal("absent") }).strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string().min(1) }).strict(),
]);
export type ThreadPullRequest = z.infer<typeof threadPullRequestSchema>;

export const pullRequestMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = z.infer<typeof pullRequestMergeMethodSchema>;

export const pullRequestActionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ready") }).strict(),
  z.object({ operation: z.literal("draft") }).strict(),
  z.object({ operation: z.literal("merge"), method: pullRequestMergeMethodSchema }).strict(),
]);
export type PullRequestAction = z.infer<typeof pullRequestActionSchema>;

/** What the host found for one branch. */
export const hostPullRequestLookupSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("found"), pullRequest: gitHubPullRequestViewSchema }).strict(),
  z.object({ outcome: z.literal("none") }).strict(),
  z.object({ outcome: z.literal("unavailable"), message: z.string().min(1) }).strict(),
]);
export type HostPullRequestLookup = z.infer<typeof hostPullRequestLookupSchema>;

export const THREAD_PULL_REQUESTS_MAX_KEYS = 200;

export function threadPullRequestTag(threadId: string): string {
  return `thread:${threadId}`;
}
