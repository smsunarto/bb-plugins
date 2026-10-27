// Shared domain types + zod schemas for SlopCop.
//
// Rules and runs are persisted in the plugin's own SQLite database; the zod
// schemas here are the single validation boundary shared by the RPC contract,
// the CLI, and the row (de)serializers.
import { z } from "zod";

/** GitHub's authorAssociation values, in descending order of trust. */
export const AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const;
export type AuthorAssociation = (typeof AUTHOR_ASSOCIATIONS)[number];

/**
 * Which authors a rule will review.
 *
 * `org_members` admits only organization owners and members. `write_access` is
 * the default and also admits outside collaborators. GitHub's `CONTRIBUTOR`
 * means "has had a commit merged before", NOT write access, so a drive-by
 * who landed one typo fix qualifies.
 * It is therefore excluded from `write_access` and named honestly in the other
 * level.
 */
export const authorTrustSchema = z.enum([
  "org_members",
  "write_access",
  "past_contributors",
  "anyone",
]);
export type AuthorTrust = z.infer<typeof authorTrustSchema>;

export const TRUSTED_ASSOCIATIONS: Record<AuthorTrust, readonly AuthorAssociation[]> = {
  org_members: ["OWNER", "MEMBER"],
  write_access: ["OWNER", "MEMBER", "COLLABORATOR"],
  past_contributors: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
  anyone: AUTHOR_ASSOCIATIONS,
};

export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paths"), globs: z.array(z.string()).min(1) }),
  z.object({
    kind: z.literal("base_branch"),
    globs: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("has_label"),
    labels: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("missing_label"),
    labels: z.array(z.string()).min(1),
  }),
  z.object({ kind: z.literal("author"), logins: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("title_matches"), regex: z.string().min(1) }),
  z.object({
    kind: z.literal("max_changed_files"),
    value: z.number().int().positive(),
  }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const triggerSchema = z.enum([
  "ready_for_review",
  "new_commits",
  "new_issue",
  "pr_description_matches",
  "comment_matches",
  "manual",
]);
export type Trigger = z.infer<typeof triggerSchema>;

export const targetKindSchema = z.enum(["pull_request", "issue"]);
export type TargetKind = z.infer<typeof targetKindSchema>;

/**
 * The composer's resolved selections, stored verbatim and replayed at dispatch.
 * Kept loose on purpose: this round-trips through `threads.spawn` and BB owns
 * its exact shape, so SlopCop validates only the fields it reads.
 */
export const threadRequestSchema = z
  .object({
    projectId: z.string(),
    providerId: z.string(),
    model: z.string(),
    reasoningLevel: z.unknown().optional(),
    permissionMode: z.string().optional(),
    serviceTier: z.unknown().optional(),
    executionInputSources: z.unknown().optional(),
    // Both optional: `z.unknown()` is REQUIRED in zod 4, and a CLI-built
    // request legitimately has neither — SlopCop supplies its own prompt at
    // dispatch and drops the composer's stored `input` there anyway.
    environment: z.unknown().optional(),
    input: z.unknown().optional(),
  })
  .passthrough();
export type ThreadRequest = z.infer<typeof threadRequestSchema>;

/** Shadow runs review and store the body but never post to GitHub. */
export const ruleModeSchema = z.enum(["shadow", "live"]);
export type RuleMode = z.infer<typeof ruleModeSchema>;

/** How a re-review on new commits reconciles with the previous comment set. */
export const reviewStrategySchema = z.enum(["update", "replace", "append"]);
export type ReviewStrategy = z.infer<typeof reviewStrategySchema>;

/**
 * Hidden review threads stay out of sidebar organization and raise no unread
 * or notification attention — right for a rule that fires often enough to be
 * noise. Visible is the default so a new rule is watchable while you tune it.
 */
export const visibilitySchema = z.enum(["visible", "hidden"]);
export type Visibility = z.infer<typeof visibilitySchema>;

export const dedupeSchema = z.enum(["once_per_pr", "once_per_head_sha", "once_per_trigger_event"]);
export type Dedupe = z.infer<typeof dedupeSchema>;

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo"),
  enabled: z.boolean(),
  mode: ruleModeSchema,
  triggers: z.array(triggerSchema).min(1),
  commentKeywords: z.array(z.string().min(1)),
  conditions: z.array(conditionSchema),
  authorTrust: authorTrustSchema,
  requesterTrust: authorTrustSchema,
  commentTriggerEnabledAt: z.number().int().nullable(),
  prompt: z.string(),
  request: threadRequestSchema.nullable(),
  dedupe: dedupeSchema,
  reviewStrategy: reviewStrategySchema,
  visibility: visibilitySchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const runStatusSchema = z.enum([
  "dispatched",
  "reviewing",
  "commented",
  "commented_partial",
  "commented_unmarked",
  "commented_unattributed",
  "shadowed",
  "no_comment",
  "skipped",
  "failed",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const commentKindSchema = z.enum(["summary", "inline", "reply"]);
export type CommentKind = z.infer<typeof commentKindSchema>;

export interface RunComment {
  runId: string;
  githubId: string | null;
  kind: CommentKind;
  path: string | null;
  line: number | null;
  url: string | null;
  bodyExcerpt: string;
  attribution: "marker" | "header" | "account";
}

export interface Run {
  id: string;
  ruleId: string;
  ruleName: string;
  repo: string;
  targetKind: TargetKind;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  headSha: string;
  trigger: Trigger;
  triggerEventId: string | null;
  status: RunStatus;
  mode: RuleMode;
  detail: string | null;
  threadId: string | null;
  commentCount: number;
  startedAt: number;
  finishedAt: number | null;
}

/** The PR fields SlopCop reads, as returned by `gh pr list --json`. */
export interface PullRequest {
  kind: "pull_request";
  number: number;
  title: string;
  body: string;
  createdAt: number;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  author: { login: string } | null;
  authorAssociation: AuthorAssociation | string;
  labels: { name: string }[];
  files: { path: string }[];
  isCrossRepository: boolean;
  updatedAt: string;
}

/** The issue fields SlopCop reads from GitHub's REST API. */
export interface GitHubIssue {
  kind: "issue";
  number: number;
  title: string;
  body: string;
  author: { login: string } | null;
  authorAssociation: AuthorAssociation | string;
  labels: { name: string }[];
  createdAt: string;
  updatedAt: string;
}

export type GitHubTarget = PullRequest | GitHubIssue;

export type TriggerCommentSource = "issue" | "review";

/** A PR comment that can request a SlopCop review. */
export interface TriggerComment {
  id: string;
  source: TriggerCommentSource;
  repo: string;
  prNumber: number;
  body: string;
  url: string | null;
  author: string | null;
  authorAssociation: AuthorAssociation | string;
  createdAt: number;
  updatedAt: number;
}

/** A durable request. The watcher keeps it pending when review capacity is full. */
export interface CommentTriggerEvent {
  ruleId: string;
  source: TriggerCommentSource;
  commentId: string;
  repo: string;
  prNumber: number;
  author: string;
  authorAssociation: string;
  matchedKeyword: string;
  url: string | null;
  createdAt: number;
  status: "pending" | "processed" | "ignored";
  detail: string | null;
}
