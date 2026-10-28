// What the BB-backed Project components (Changes, Commits, PullRequest,
// Threads, Environments) show: the shapes the backend (project/) answers
// with, which the renderer and the markdown fallback both read, and the pure
// helpers they share. Nothing here talks to BB; project/source.ts does.
// Environments' own shapes are in environments.ts.
import type { EnvironmentsView } from "./environments";
import type { LastMessage, PendingAsk } from "./thread-activity";

/** BB thread ids: `thr_` and lowercase letters and digits. */
export const THREAD_ID = /^thr_[a-z0-9]{4,40}$/;

/** A full or abbreviated git commit sha, lowercase. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/** Most paths a Changes filter may name. */
export const MAX_PATH_FILTERS = 50;

/** Most thread ids a Threads list may name. */
export const MAX_THREAD_IDS = 50;

/** Most commits a Commits list keeps. */
export const MAX_COMMITS = 500;

// ── Requests ────────────────────────────────────────────────────────────────

/** Which changes Changes shows. */
export type ChangesTarget =
  /** The branch's work against the default branch, committed and uncommitted. */
  | { readonly kind: "branch" }
  | { readonly kind: "uncommitted" }
  | { readonly kind: "commit"; readonly sha: string };

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** `target` as written: omitted, `"uncommitted"`, or a commit sha (7–40 hex digits). */
export function parseChangesTarget(value: unknown): Parsed<ChangesTarget> {
  if (value === undefined || value === null) return { ok: true, value: { kind: "branch" } };
  const written = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (written === "") return { ok: true, value: { kind: "branch" } };
  if (written === "uncommitted") return { ok: true, value: { kind: "uncommitted" } };
  if (written !== null && COMMIT_SHA.test(written)) return { ok: true, value: { kind: "commit", sha: written } };
  return {
    ok: false,
    error: `Changes target must be omitted, "uncommitted" or a commit sha, not ${JSON.stringify(value)}`,
  };
}

/**
 * `paths` as written: null (no filter) or the repository-relative paths and
 * directory prefixes to keep, without `./` or a trailing slash.
 */
export function parsePathFilter(value: unknown): Parsed<readonly string[] | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: "Changes paths must be a list of paths" };
  if (value.length > MAX_PATH_FILTERS) return { ok: false, error: `Changes takes at most ${MAX_PATH_FILTERS} paths` };
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { ok: false, error: "Changes paths must be strings" };
    const path = item.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (path === "" || path === ".") return { ok: false, error: `"${item}" is not a path in the repository` };
    if (!paths.includes(path)) paths.push(path);
  }
  // An empty list keeps everything, like no list.
  return { ok: true, value: paths.length === 0 ? null : paths };
}

/** True when `path` is one of `filter` or inside one of its directories. */
export function matchesPathFilter(path: string, filter: readonly string[] | null): boolean {
  return filter === null || filter.some((kept) => path === kept || path.startsWith(`${kept}/`));
}

/** `limit` as written: null (all) or a whole number of commits from 1. */
export function parseCommitLimit(value: unknown): Parsed<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return { ok: false, error: "Commits limit must be a number from 1" };
  }
  return { ok: true, value: Math.min(MAX_COMMITS, Math.floor(value)) };
}

/** `ids` as written: null (the thread's subthreads) or the ids, repeats dropped. */
export function parseThreadIds(value: unknown): Parsed<readonly string[] | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { ok: false, error: "Threads ids must be a list of thread ids" };
  }
  const ids = [...new Set((value as string[]).map((id) => id.trim()).filter((id) => id !== ""))];
  if (ids.length > MAX_THREAD_IDS) return { ok: false, error: `Threads takes at most ${MAX_THREAD_IDS} ids` };
  return { ok: true, value: ids };
}

/** One read of BB state a rendered reply needs, as the markdown fallback collects them. */
export type ProjectRequest =
  | { readonly kind: "changes"; readonly target: ChangesTarget; readonly paths: readonly string[] | null }
  | { readonly kind: "commits" }
  | { readonly kind: "pullRequest" }
  | { readonly kind: "threads"; readonly ids: readonly string[] | null }
  | { readonly kind: "environments" };

export function projectRequestKey(request: ProjectRequest): string {
  return JSON.stringify(request);
}

// ── Answers ─────────────────────────────────────────────────────────────────

/** Why BB state couldn't be read, in one sentence for the user. */
export interface ProjectFailure {
  readonly ok: false;
  readonly reason: "no-thread" | "not-found" | "no-environment" | "not-git" | "unavailable" | "invalid";
  readonly message: string;
}

export type ChangeKind = "added" | "copied" | "deleted" | "modified" | "renamed" | "type_changed";

/** How a file's diff can be shown: BB sent it, fetches it on request, or won't show text. */
export type DiffAvailability = "inline" | "on-demand" | "too-large" | "binary";

export interface ChangedFile {
  readonly path: string;
  /** Where a renamed or copied file came from. */
  readonly previousPath: string | null;
  readonly kind: ChangeKind;
  readonly additions: number;
  readonly deletions: number;
  /** A new file git doesn't track yet. */
  readonly untracked: boolean;
  readonly diff: DiffAvailability;
}

export interface FilePatch {
  readonly path: string;
  readonly patch: string;
  /** BB cut the patch short. */
  readonly truncated: boolean;
}

/** What the changes are measured against, for the header. */
export type ChangesScope =
  /** The branch against `base`, uncommitted work included. `onBase`: the checkout is on `base`, so only uncommitted work differs. */
  | {
      readonly kind: "branch";
      readonly branch: string | null;
      /** Short sha of a detached HEAD. */
      readonly head: string | null;
      readonly base: string;
      readonly onBase: boolean;
    }
  | { readonly kind: "uncommitted"; readonly branch: string | null; readonly unborn: boolean }
  | { readonly kind: "commit"; readonly sha: string; readonly subject: string | null };

export interface ChangesView {
  readonly ok: true;
  readonly scope: ChangesScope;
  /** Files the path filter keeps, in BB's order. */
  readonly files: readonly ChangedFile[];
  /** Files before the filter. */
  readonly totalFiles: number;
  readonly filter: readonly string[] | null;
  /** BB listed only part of the changed files (or the snapshot kept only part). */
  readonly listTruncated: boolean;
  /** The patches at hand; a stored snapshot carries every one that fit. */
  readonly patches: readonly FilePatch[];
  /** Whether a patch not at hand may be fetched now. False for a snapshot: today's diff isn't what it showed. */
  readonly livePatches: boolean;
  /** When BB was read (epoch ms). */
  readonly takenAt: number;
  /** Kept in plugin storage for this reply: later renders show this, not today's state. */
  readonly stored: boolean;
}

export interface CommitInfo {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly author: string;
  /** Epoch ms. */
  readonly authoredAt: number;
}

export interface CommitsView {
  readonly ok: true;
  readonly branch: string | null;
  readonly checkout: "branch" | "detached" | "unborn";
  /** Short sha of HEAD, when there is one. */
  readonly head: string | null;
  readonly base: string;
  /** The checkout is on the default branch itself. */
  readonly onBase: boolean;
  /** Null when BB couldn't find a merge base. */
  readonly ahead: number | null;
  readonly behind: number | null;
  /** Newest first. */
  readonly commits: readonly CommitInfo[];
  /** More commits than were kept. */
  readonly commitsTruncated: boolean;
  readonly takenAt: number;
  readonly stored: boolean;
}

export type PullRequestState = "open" | "draft" | "merged" | "closed";
export type ChecksState = "passing" | "failing" | "pending" | "no_checks" | "unknown";
export type ReviewState = "approved" | "changes_requested" | "review_requested" | "review_required" | "none";
export type MergeabilityState = "mergeable" | "conflicts" | "blocked" | "draft" | "unknown";
export type PullRequestAttention =
  | "blocked"
  | "changes_requested"
  | "checks_failed"
  | "checks_pending"
  | "closed"
  | "conflicts"
  | "draft"
  | "merged"
  | "none"
  | "queued"
  | "ready_to_merge"
  | "review_requested";

export interface PullRequestInfo {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PullRequestState;
  readonly baseRef: string;
  readonly headRef: string;
  readonly checks: {
    readonly state: ChecksState;
    readonly passed: number;
    readonly failed: number;
    readonly pending: number;
    readonly total: number;
  };
  readonly review: { readonly state: ReviewState; readonly requests: number };
  readonly mergeability: MergeabilityState;
  readonly attention: PullRequestAttention;
  readonly autoMerge: boolean;
  readonly inMergeQueue: boolean;
  /** Epoch ms, or null when GitHub's time didn't parse. */
  readonly updatedAt: number | null;
}

export interface PullRequestView {
  readonly ok: true;
  readonly branch: string | null;
  /** Null: the branch has no pull request. */
  readonly pullRequest: PullRequestInfo | null;
  readonly fetchedAt: number;
}

export type ThreadDisplayStatus =
  | "active"
  | "error"
  | "idle"
  | "pending"
  | "provisioning"
  | "starting"
  | "stopping"
  | "waiting-for-host";

export interface ThreadInfo {
  readonly found: true;
  readonly id: string;
  readonly title: string;
  readonly status: ThreadDisplayStatus;
  /** The thread waits for the user to answer a question or approve something. */
  readonly needsInput: boolean;
  readonly archived: boolean;
  readonly provider: { readonly id: string; readonly name: string | null; readonly logoUrl: string | null };
  readonly model: string | null;
  /** The reasoning level BB runs the thread with ("high"); null when unknown or "none". */
  readonly reasoning: string | null;
  /** Epoch ms of the last change BB recorded. */
  readonly updatedAt: number;
  /** Its latest assistant message; null when it has none yet or BB couldn't say. */
  readonly lastMessage: LastMessage | null;
  /** The question or approval it waits on the user for; null when none (or BB couldn't say which). */
  readonly pending: PendingAsk | null;
  /** Its subthreads BB is running right now. */
  readonly runningWorkers: number;
}

/** An id that names no thread this one may see: unknown, deleted, or in another project. */
export interface MissingThread {
  readonly found: false;
  readonly id: string;
}

export interface ThreadsView {
  readonly ok: true;
  /** Subthreads of the reply's thread, or the ids the spec named. */
  readonly mode: "subthreads" | "ids";
  readonly threads: readonly (ThreadInfo | MissingThread)[];
  /** BB had more subthreads than were listed. */
  readonly truncated: boolean;
  readonly fetchedAt: number;
}

export type ChangesResult = ChangesView | ProjectFailure;
export type PatchesResult =
  | { readonly ok: true; readonly patches: readonly FilePatch[] }
  | ProjectFailure;
export type CommitsResult = CommitsView | ProjectFailure;
export type PullRequestResult = PullRequestView | ProjectFailure;
export type ThreadsResult = ThreadsView | ProjectFailure;
export type EnvironmentsResult = EnvironmentsView | ProjectFailure;
export type ProjectResult = ChangesResult | CommitsResult | PullRequestResult | ThreadsResult | EnvironmentsResult;

// ── Shared wording ──────────────────────────────────────────────────────────

/** "feat/x vs main, incl. uncommitted", "uncommitted", "commit a1b2c3d". */
export function scopeLabel(scope: ChangesScope): string {
  switch (scope.kind) {
    case "branch": {
      const name = scope.branch ?? (scope.head === null ? "HEAD" : `detached ${scope.head}`);
      return scope.onBase ? `${name}, uncommitted` : `${name} vs ${scope.base}, incl. uncommitted`;
    }
    case "uncommitted":
      return scope.unborn ? "uncommitted, no commits yet" : "uncommitted";
    case "commit":
      return `commit ${scope.sha.slice(0, 7)}`;
  }
}

/** One-letter git status per change kind, as BB's diff panel and `git status` show them. */
export const CHANGE_LETTER: Record<ChangeKind, string> = {
  added: "A",
  copied: "C",
  deleted: "D",
  modified: "M",
  renamed: "R",
  type_changed: "T",
};

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  copied: "Copied",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
  type_changed: "Type changed",
};

export function changeTotals(files: readonly ChangedFile[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: files.length, additions, deletions };
}

/** A path's directory (with its trailing slash, or "") and its file name. */
export function splitPath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { directory: "", name: path } : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** Statuses in which the thread is doing (or about to do) work, so its status will change by itself. */
export const RUNNING: Record<ThreadDisplayStatus, boolean> = {
  active: true,
  pending: true,
  provisioning: true,
  starting: true,
  stopping: true,
  "waiting-for-host": true,
  idle: false,
  error: false,
};

export function threadStatusLabel(thread: Pick<ThreadInfo, "status" | "needsInput" | "archived">): string {
  if (thread.needsInput) return "Needs input";
  switch (thread.status) {
    case "active":
      return "Running";
    case "error":
      return "Failed";
    case "idle":
      return thread.archived ? "Archived" : "Idle";
    case "pending":
      return "Queued";
    case "provisioning":
      return "Preparing";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "waiting-for-host":
      return "Waiting for machine";
  }
}

export const PR_STATE_LABEL: Record<PullRequestState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export const CHECKS_LABEL: Record<ChecksState, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
  no_checks: "No checks",
  unknown: "Checks unknown",
};

export const REVIEW_LABEL: Record<ReviewState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_requested: "Review requested",
  review_required: "Review required",
  none: "No reviews",
};

export const MERGEABILITY_LABEL: Record<MergeabilityState, string> = {
  mergeable: "Mergeable",
  conflicts: "Conflicts",
  blocked: "Blocked",
  draft: "Draft",
  unknown: "Mergeability unknown",
};

/** BB's attention reason: what the pull request waits for now. Null when nothing does. */
export const ATTENTION_LABEL: Record<PullRequestAttention, string | null> = {
  blocked: "Blocked by branch rules",
  changes_requested: "Changes requested",
  checks_failed: "Checks failed",
  checks_pending: "Waiting for checks",
  closed: null,
  conflicts: "Has merge conflicts",
  draft: "Draft: not ready for review",
  merged: null,
  none: null,
  queued: "In the merge queue",
  ready_to_merge: "Ready to merge",
  review_requested: "Waiting for review",
};

/** "2 failed · 5 passed · 1 running", only the counts that aren't zero. */
export function checkCounts(checks: PullRequestInfo["checks"]): string {
  return [
    checks.failed > 0 ? `${checks.failed} failed` : "",
    checks.passed > 0 ? `${checks.passed} passed` : "",
    checks.pending > 0 ? `${checks.pending} running` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** Something on the pull request will change without anyone acting: checks running, mergeability being computed, the queue. */
export function pullRequestSettling(pullRequest: PullRequestInfo): boolean {
  if (pullRequest.state === "merged" || pullRequest.state === "closed") return false;
  return pullRequest.checks.state === "pending" || pullRequest.mergeability === "unknown" || pullRequest.inMergeQueue;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const LONG_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function relativeTime(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return "yesterday";
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  const date = new Date(at);
  return (date.getFullYear() === new Date(now).getFullYear() ? SHORT_DATE : LONG_DATE).format(date);
}
