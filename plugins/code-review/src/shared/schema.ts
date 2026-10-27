import { unityDiffSchema, unityMetaDiffSchema } from "@bb-plugins/unity-inspector/model";
import { z } from "zod";

/*
 * The plugin's domain, shared by the server (which parses GitHub into it) and
 * the app (which renders it). Browser-safe: no node imports.
 *
 * GitHub is the source of truth for pull request review state. Draft comments live in
 * the viewer's PENDING review on GitHub, so github.com and this plugin show
 * the same drafts, and nothing is posted until the review is submitted.
 */

// ── Accounts ─────────────────────────────────────────────────────────────

/**
 * A github.com login `gh` is signed in to on the bb server. Every GitHub read
 * and write names the account it acts as: drafts, viewed marks, and review
 * requests all belong to one person.
 */
export const accountSchema = z
  .string()
  // Enterprise Managed Users add `_<shortcode>`, e.g. `mona-cat_octo`. Never a leading dash.
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "Not a GitHub login.");
export type Account = z.infer<typeof accountSchema>;

/** `login` and `other` are one GitHub account: logins ignore case. */
export function sameAccount(login: string, other: string): boolean {
  return login.toLowerCase() === other.toLowerCase();
}

// ── Pull request identity ────────────────────────────────────────────────

export const prRefSchema = z.strictObject({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
});
export type PrRef = z.infer<typeof prRefSchema>;

/**
 * A pinned pull request and the account it was pinned as, which the inbox
 * reads it with. Pins saved before accounts existed have none and read as
 * gh's active account.
 */
export const pinSchema = prRefSchema.extend({ account: accountSchema.optional() });
export type Pin = z.infer<typeof pinSchema>;

/** `owner/repo#123`. Stable storage and query key for one pull request. */
export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * What a bb review or fix works on, as storage and realtime name it: a pull
 * request's {@link prKey}, or `branch:<id>` for an unpublished branch.
 */
export function branchKey(id: string): string {
  return `branch:${id}`;
}

export function sameRef(a: PrRef, b: PrRef): boolean {
  return prKey(a).toLowerCase() === prKey(b).toLowerCase();
}

const NAME = "[A-Za-z0-9_.-]+";
const URL_PATTERN = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?:[/?#].*)?$`,
);
const SHORT_PATTERN = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);

/**
 * Reads a pull request from what a user pastes: a github.com pull request URL
 * (any tab, query, or anchor) or `owner/repo#123`. Null for anything else.
 */
export function parsePrReference(text: string): PrRef | null {
  const trimmed = text.trim();
  const match = URL_PATTERN.exec(trimmed) ?? SHORT_PATTERN.exec(trimmed);
  if (!match) return null;
  const [, owner, repo, digits] = match;
  const number = Number(digits);
  if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) return null;
  return { owner, repo, number };
}

// ── Routing ──────────────────────────────────────────────────────────────

export const PR_TABS = ["summary", "changes", "checks"] as const;
export type PrTab = (typeof PR_TABS)[number];

export type PrRoute = { ref: PrRef; tab: PrTab; account: Account | null };

/**
 * The page's subPath for a pull request tab read as `account`:
 * `@login/owner/repo/pull/123[/changes|/checks]`. Without an account the
 * page picks one, so a pasted link still opens.
 */
export function prSubPath(ref: PrRef, tab: PrTab = "summary", account?: Account | null): string {
  const pull = `${ref.owner}/${ref.repo}/pull/${ref.number}`;
  const base = account ? `@${account}/${pull}` : pull;
  return tab === "summary" ? base : `${base}/${tab}`;
}

/** Inverse of {@link prSubPath}. Null for the inbox (`""`) and anything unknown. */
export function parsePrSubPath(subPath: string): PrRoute | null {
  let all: string[];
  try {
    // BB's URL router may pass encoded path segments (notably `%40login`).
    all = subPath
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  // A login never holds `@`, and an owner never starts with one.
  const login = all[0]?.startsWith("@") ? all[0].slice(1) : null;
  const account = login === null ? null : accountSchema.safeParse(login);
  if (account && !account.success) return null;
  const parts = login === null ? all : all.slice(1);
  if (parts.length < 4 || parts.length > 5 || parts[2] !== "pull") return null;
  const ref = parsePrReference(`${parts[0]}/${parts[1]}#${parts[3]}`);
  if (!ref) return null;
  const tab = parts[4] ?? "summary";
  if (!(PR_TABS as readonly string[]).includes(tab)) return null;
  return { ref, tab: tab as PrTab, account: account?.data ?? null };
}

export const BRANCH_TABS = ["summary", "changes"] as const;
export type BranchTab = (typeof BRANCH_TABS)[number];

/** An unpublished branch's id: hex, from its machine, checkout, and name. */
export const branchIdSchema = z.string().regex(/^[0-9a-f]{12}$/, "Not a branch id.");

/** Local review marks belong to one immutable comparison, including its base. */
export const branchReviewRangeSchema = z.strictObject({
  id: branchIdSchema,
  base: z.string().regex(/^[0-9a-f]{40,64}$/),
  head: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type BranchReviewRange = z.infer<typeof branchReviewRangeSchema>;
/** A shared comparison remains addressable after its branch leaves GitButler. */
export const sharedComparisonInputSchema = branchReviewRangeSchema.extend({
  threadId: z.string().min(1).optional(),
});
export type SharedComparisonInput = z.infer<typeof sharedComparisonInputSchema>;
export const localComparisonSchema = branchReviewRangeSchema.extend({
  hostId: z.string().min(1),
  path: z.string().min(1),
});
export type LocalComparison = z.infer<typeof localComparisonSchema>;

export function sharedComparisonSubPath(range: SharedComparisonInput): string {
  return `shared/${range.id}/${range.base}/${range.head}${range.threadId ? `/${encodeURIComponent(range.threadId)}` : ""}`;
}

export function parseSharedComparisonSubPath(subPath: string): SharedComparisonInput | null {
  const parts = subPath.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "shared" || parts.length < 4 || parts.length > 5) return null;
  try {
    const parsed = sharedComparisonInputSchema.safeParse({
      id: parts[1],
      base: parts[2],
      head: parts[3],
      ...(parts[4] ? { threadId: decodeURIComponent(parts[4]) } : {}),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export const branchReviewedSchema = z.strictObject({ paths: z.array(z.string()) });
export type BranchReviewed = z.infer<typeof branchReviewedSchema>;
export const BRANCH_REVIEW_CHANNEL = "branch-review";

export function branchReviewRange(
  branch: Pick<LocalBranch, "id" | "base" | "head">,
): BranchReviewRange {
  return { id: branch.id, base: branch.base, head: branch.head };
}

export type BranchRoute = { id: string; tab: BranchTab };

/** The page's subPath for an unpublished branch tab: `branch/<id>[/changes]`. */
export function branchSubPath(id: string, tab: BranchTab = "summary"): string {
  return tab === "summary" ? `branch/${id}` : `branch/${id}/${tab}`;
}

/** Inverse of {@link branchSubPath}. Null for anything else. */
export function parseBranchSubPath(subPath: string): BranchRoute | null {
  const parts = subPath.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "branch") return null;
  const id = branchIdSchema.safeParse(parts[1]);
  const tab = parts[2] ?? "summary";
  if (!id.success || !(BRANCH_TABS as readonly string[]).includes(tab)) return null;
  return { id: id.data, tab: tab as BranchTab };
}

// ── Shared vocabulary ────────────────────────────────────────────────────

export const actorSchema = z.object({ login: z.string(), avatarUrl: z.string().nullable() });
export type Actor = z.infer<typeof actorSchema>;

export const prStateSchema = z.enum(["open", "closed", "merged"]);
export type PrState = z.infer<typeof prStateSchema>;

/** GitHub's review decision for the pull request as a whole. */
export const reviewDecisionSchema = z.enum(["approved", "changes_requested", "review_required"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/** One person's latest review. `pending` is an unsubmitted (draft) review. */
export const reviewStateSchema = z.enum([
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
  "pending",
]);
export type ReviewState = z.infer<typeof reviewStateSchema>;

/** The rolled-up state of every check on the head commit. */
export const checksStateSchema = z.enum(["success", "failure", "pending", "neutral"]);
export type ChecksState = z.infer<typeof checksStateSchema>;

/** GitHub's diff side: LEFT is the base (deleted lines), RIGHT is the head. */
export const diffSideSchema = z.enum(["LEFT", "RIGHT"]);
export type DiffSide = z.infer<typeof diffSideSchema>;

export const reviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

// ── Status ───────────────────────────────────────────────────────────────

/** Whether the server can reach GitHub through the `gh` CLI, and as whom. */
export const statusSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** gh's active account: the one a pull request opens as when nothing says otherwise. */
    login: accountSchema,
    /** Every signed-in github.com account, the active one first. */
    accounts: z.array(accountSchema).min(1),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["gh-missing", "unauthenticated", "failed"]),
    message: z.string(),
  }),
]);
export type Status = z.infer<typeof statusSchema>;

// ── Inbox ────────────────────────────────────────────────────────────────

export const inboxPrSchema = z.object({
  ref: prRefSchema,
  /** The signed-in account this pull request waits on, or was pinned as. Its page acts as it. */
  account: accountSchema,
  title: z.string(),
  url: z.string(),
  state: prStateSchema,
  isDraft: z.boolean(),
  updatedAt: z.string(),
  author: actorSchema.nullable(),
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: reviewDecisionSchema.nullable(),
  checks: checksStateSchema.nullable(),
  /** The viewer's own latest review on this pull request. */
  viewerReview: reviewStateSchema.nullable(),
  /** A review is requested from the viewer directly (not only through a team). */
  reviewRequestedFromViewer: z.boolean(),
});
export type InboxPr = z.infer<typeof inboxPrSchema>;

export const INBOX_SECTIONS = ["assigned", "team", "authored"] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];

/** A signed-in account whose queues could not be read, and why. */
export const unavailableAccountSchema = z.object({ account: accountSchema, message: z.string() });

/**
 * Every signed-in account's queues, merged. A pull request shows once per
 * section, as the first account (active first) it waits on.
 */
export const inboxSchema = z.object({
  /** Every signed-in account, the active one first. */
  accounts: z.array(accountSchema),
  /** Accounts whose queues failed to load. The rest still show. */
  unavailable: z.array(unavailableAccountSchema),
  /** Review requested from the viewer directly, or assigned to the viewer. */
  assigned: z.array(inboxPrSchema),
  /** Review requested from one of the viewer's teams, and not the viewer directly. */
  team: z.array(inboxPrSchema),
  /** Open pull requests the viewer opened. */
  authored: z.array(inboxPrSchema),
  /** Pull requests the viewer pinned, in pin order, in any state. */
  pinned: z.array(inboxPrSchema),
});
export type Inbox = z.infer<typeof inboxSchema>;

// ── Pull request detail ──────────────────────────────────────────────────

export const reviewerSchema = z.object({
  /** `login` for a user, `org/slug` for a team. */
  name: z.string(),
  kind: z.enum(["user", "team"]),
  avatarUrl: z.string().nullable(),
  /** `requested` while their review is outstanding. */
  state: z.union([reviewStateSchema, z.literal("requested")]),
});
export type Reviewer = z.infer<typeof reviewerSchema>;

export const timelineItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comment"),
    id: z.string(),
    author: actorSchema.nullable(),
    body: z.string(),
    createdAt: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal("review"),
    id: z.string(),
    author: actorSchema.nullable(),
    state: reviewStateSchema,
    body: z.string(),
    createdAt: z.string(),
    url: z.string(),
    /** Inline comments submitted with this review. */
    commentCount: z.number(),
  }),
  z.object({
    kind: z.literal("commit"),
    id: z.string(),
    oid: z.string(),
    message: z.string(),
    author: actorSchema.nullable(),
    createdAt: z.string(),
  }),
  z.object({
    kind: z.literal("event"),
    id: z.string(),
    actor: actorSchema.nullable(),
    /** A short past-tense phrase that follows the actor, e.g. "force-pushed the branch". */
    text: z.string(),
    createdAt: z.string(),
  }),
]);
export type TimelineItem = z.infer<typeof timelineItemSchema>;

export const threadCommentSchema = z.object({
  /** GraphQL node id. Draft edit and delete take this. */
  id: z.string(),
  author: actorSchema.nullable(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
  /** Part of the viewer's unsubmitted review: visible only to the viewer. */
  isDraft: z.boolean(),
});
export type ThreadComment = z.infer<typeof threadCommentSchema>;

export const reviewThreadSchema = z.object({
  id: z.string(),
  path: z.string(),
  /** Line on `side` the thread ends on, in the current diff. Null when outdated. */
  line: z.number().nullable(),
  /** First line of a multi-line thread. Null for single-line threads. */
  startLine: z.number().nullable(),
  /** Side of `startLine`. A range can start in the base and end in the head. */
  startSide: diffSideSchema.nullable(),
  side: diffSideSchema,
  /** The line the thread was written against, kept when it becomes outdated. */
  originalLine: z.number().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  /** File-level thread with no line. */
  isFileLevel: z.boolean(),
  diffHunk: z.string(),
  comments: z.array(threadCommentSchema),
});
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

export const stackPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: prStateSchema,
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
});
export type StackPr = z.infer<typeof stackPrSchema>;

export const pullRequestSchema = z.object({
  ref: prRefSchema,
  /** The signed-in account this was read as. Every later read and write on it names the same one. */
  account: accountSchema,
  /** GraphQL node id. Every review mutation takes it. */
  id: z.string(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: prStateSchema,
  isDraft: z.boolean(),
  author: actorSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  baseRefOid: z.string(),
  /** `owner/repo` the head branch lives in. Differs from the base repo for forks. */
  headRepository: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  commitCount: z.number(),
  reviewDecision: reviewDecisionSchema.nullable(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  viewer: z.object({
    login: z.string(),
    isAuthor: z.boolean(),
    /** GitHub lets the viewer approve or request changes (not the author). */
    canApprove: z.boolean(),
  }),
  reviewers: z.array(reviewerSchema),
  timeline: z.array(timelineItemSchema),
  threads: z.array(reviewThreadSchema),
  /** The viewer's unsubmitted review, holding every draft comment. */
  pendingReview: z.object({ id: z.string(), body: z.string(), draftCount: z.number() }).nullable(),
  stack: z.object({ parent: stackPrSchema.nullable(), children: z.array(stackPrSchema) }),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

// ── Changed files ────────────────────────────────────────────────────────

/**
 * The diff a line number counts in. A push moves the head, and a retarget
 * moves the base without moving the head, so naming one takes both. The base
 * is a branch name: new commits on the base branch leave the diff as it was.
 */
export type DiffRevision = { headRefOid: string; baseRefName: string };

export function sameRevision(a: DiffRevision, b: DiffRevision): boolean {
  return a.headRefOid === b.headRefOid && a.baseRefName === b.baseRefName;
}

export const fileStatusSchema = z.enum([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);
export type FileStatus = z.infer<typeof fileStatusSchema>;

/**
 * GitHub's per-viewer "viewed" marker. `dismissed` means the viewer marked
 * the file viewed, then it changed in a later push: it reads as unviewed.
 */
export const viewedStateSchema = z.enum(["viewed", "unviewed", "dismissed"]);
export type ViewedState = z.infer<typeof viewedStateSchema>;

export const changedFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: fileStatusSchema,
  additions: z.number(),
  deletions: z.number(),
  /**
   * The unified diff hunks GitHub returns for the file, with no file header.
   * Null for binary files and for files too large for GitHub to diff.
   */
  patch: z.string().nullable(),
  viewed: viewedStateSchema,
  /** Machine-written (a lockfile, build output, `linguist-generated`), so it sorts last and starts folded. */
  generated: z.boolean(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

const commitOidSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "Not a commit id.");

/**
 * Where both sides of a diff's files are read, pinned by commit so a file's
 * preview shows the very comparison its patch does. A pull request's base
 * side is the merge base of `base` and `head`, as GitHub diffs it; a local
 * branch's is `base` itself.
 */
export const comparisonSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github"),
    account: accountSchema,
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    /** `owner/repo` the head commits were pushed to: a fork's own Git LFS store holds its files. */
    headRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable(),
    base: commitOidSchema,
    head: commitOidSchema,
  }),
  z.strictObject({
    kind: z.literal("local"),
    hostId: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    base: commitOidSchema,
    head: commitOidSchema,
  }),
]);
export type Comparison = z.infer<typeof comparisonSchema>;
export type ComparisonSide = "base" | "head";

export const changedFilesSchema = z.object({
  /** The head commit these patches belong to. */
  headRefOid: z.string(),
  /** The base branch these patches compare against. */
  baseRefName: z.string(),
  /** Where previews read whole files. Null when the read could not pin both commits. */
  comparison: comparisonSchema.nullable(),
  files: z.array(changedFileSchema),
});
export type ChangedFiles = z.infer<typeof changedFilesSchema>;

/** A Git LFS pointer's object. */
export const lfsObjectSchema = z.strictObject({
  oid: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export type LfsObject = z.infer<typeof lfsObjectSchema>;

/** What one side of a changed file holds, read without its content. */
export const blobDescriptorSchema = z.discriminatedUnion("kind", [
  /** Not in that commit: the file was added or deleted. */
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({
    kind: z.literal("blob"),
    /** The bytes Git stores: a pointer's own size for a Git LFS file. */
    size: z.number().int().nonnegative(),
    lfs: lfsObjectSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("symlink"), target: z.string() }),
  z.strictObject({ kind: z.literal("submodule") }),
]);
export type BlobDescriptor = z.infer<typeof blobDescriptorSchema>;

export const fileBlobsSchema = z.strictObject({
  base: blobDescriptorSchema,
  head: blobDescriptorSchema,
});
export type FileBlobs = z.infer<typeof fileBlobsSchema>;

/** A Unity asset's change as objects and properties, or why only its text diff shows. */
export const unityPreviewSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("objects"), diff: unityDiffSchema }),
  z.strictObject({ state: z.literal("meta"), diff: unityMetaDiffSchema }),
  z.strictObject({ state: z.literal("unavailable"), reason: z.string() }),
]);
export type UnityPreview = z.infer<typeof unityPreviewSchema>;

// ── Unpublished branches ─────────────────────────────────────────────────

export const localCommitSchema = z.object({
  commitId: z.string(),
  message: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});
export type LocalCommit = z.infer<typeof localCommitSchema>;

/**
 * A GitButler branch with commits and no pull request, in a checkout on a
 * machine bb knows. The GitButler plugin reads them; see `lib/gitbutler.ts`.
 */
export const localBranchSchema = z.object({
  id: branchIdSchema,
  hostId: z.string(),
  machine: z.string(),
  /** The checkout's path on its machine. */
  path: z.string(),
  repoName: z.string(),
  /** `owner/repo` on github.com. Null for a checkout with no GitHub origin. */
  repository: z.string().nullable(),
  branch: z.string(),
  /** GitButler's push status: `unpushed`, `ahead`, `pushed`, … */
  status: z.string(),
  head: z.string(),
  /** The commit the branch starts from. `base..head` is the branch. */
  base: z.string(),
  /** The branch it is stacked on, or null at the bottom of its stack. */
  parent: z.string().nullable(),
  /** Newest first. */
  commits: z.array(localCommitSchema).min(1),
});
export type LocalBranch = z.infer<typeof localBranchSchema>;

/** Unpublished branches, or why there are none to read: the GitButler plugin is not on. */
export const localBranchesSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), branches: z.array(localBranchSchema) }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type LocalBranches = z.infer<typeof localBranchesSchema>;

// ── Checks ───────────────────────────────────────────────────────────────

/** One check, normalized from a GitHub check run or a commit status. */
export const checkSchema = z.object({
  /** `run:<databaseId>` for a check run, `status:<context>` for a commit status. */
  id: z.string(),
  name: z.string(),
  /** Workflow or app that produced it, e.g. "CI". Null for commit statuses. */
  workflow: z.string().nullable(),
  state: z.enum(["success", "failure", "pending", "neutral", "skipped", "cancelled"]),
  /** Short description: the check's title or the status description. */
  description: z.string().nullable(),
  detailsUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** GitHub Actions job id, when logs can be fetched with `gh run view --job`. */
  jobId: z.number().nullable(),
});
export type Check = z.infer<typeof checkSchema>;

export const checksSchema = z.object({
  headRefOid: z.string(),
  state: checksStateSchema.nullable(),
  checks: z.array(checkSchema),
});
export type Checks = z.infer<typeof checksSchema>;

// ── bb reviews and linked threads ─────────────────────────────────────

/** P0 blocks release, P1 is urgent, P2 is an ordinary defect, P3 is low impact. */
export const findingSchema = z.object({
  id: z.string(),
  priority: z.number().int().min(0).max(3),
  title: z.string(),
  body: z.string(),
  path: z.string(),
  /** Last line of the finding on `side`. */
  line: z.number().int().positive(),
  startLine: z.number().int().positive().nullable(),
  side: diffSideSchema,
});
export type Finding = z.infer<typeof findingSchema>;

export const linkedThreadSchema = z.object({
  threadId: z.string(),
  kind: z.enum(["review", "fix"]),
  title: z.string().nullable(),
  status: z.enum(["pending", "starting", "active", "idle", "error", "stopping", "missing"]),
  createdAt: z.string(),
  /** Head commit when the thread started. A review of an older head is stale. */
  headRefOid: z.string(),
  /** Base branch when the thread started. A review against another base is stale too. */
  baseRefName: z.string(),
});
export type LinkedThread = z.infer<typeof linkedThreadSchema>;

export const reviewRunSchema = z.object({
  threadId: z.string(),
  /** The diff bb reviewed, which the findings' line numbers count in. */
  headRefOid: z.string(),
  baseRefName: z.string(),
  /** Set once the review agent reports. Null while it is still reviewing. */
  reportedAt: z.string().nullable(),
  summary: z.string().nullable(),
  findings: z.array(findingSchema),
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;

export const agentActivitySchema = z.object({
  threads: z.array(linkedThreadSchema),
  /** The newest bb review of this pull request, if any. */
  latestReview: reviewRunSchema.nullable(),
});
export type AgentActivity = z.infer<typeof agentActivitySchema>;

/** Realtime channel the server publishes `{ key: prKey }` on when agent activity changes. */
export const AGENT_ACTIVITY_CHANNEL = "agent-activity";
