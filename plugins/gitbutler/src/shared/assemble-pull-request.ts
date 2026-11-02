/**
 * One rolled-up status per pull request, as bb's bundled GitHub PR Status
 * plugin assembles it: checks, review, mergeability, and what needs doing.
 */
import type {
  GitHubPullRequestCheck,
  GitHubPullRequestView,
  PullRequest,
  PullRequestAttentionState,
  PullRequestChecks,
  PullRequestMergeability,
  PullRequestReview,
} from "./pull-request.ts";

function isSameOrLater(candidate: GitHubPullRequestCheck, current: GitHubPullRequestCheck) {
  if (candidate.startedAt === null) return current.startedAt === null;
  if (current.startedAt === null) return true;
  return Date.parse(candidate.startedAt) >= Date.parse(current.startedAt);
}

function assembleChecks(raw: readonly GitHubPullRequestCheck[]): PullRequestChecks {
  const latest = new Map<string, GitHubPullRequestCheck>();
  for (const check of raw) {
    const current = latest.get(check.name);
    if (!current || isSameOrLater(check, current)) latest.set(check.name, check);
  }
  let passedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let unknownCount = 0;
  for (const check of latest.values()) {
    if (check.status === "queued" || check.status === "in_progress") {
      pendingCount += 1;
      continue;
    }
    switch (check.conclusion) {
      case "success":
      case "skipped":
      case "neutral":
        passedCount += 1;
        break;
      case "failure":
      case "cancelled":
      case "timed_out":
      case "action_required":
      case "startup_failure":
      case "stale":
        failedCount += 1;
        break;
      case "unknown":
      case null:
        unknownCount += 1;
        break;
    }
  }
  const state =
    latest.size === 0
      ? "no_checks"
      : failedCount > 0
        ? "failing"
        : pendingCount > 0
          ? "pending"
          : unknownCount > 0
            ? "unknown"
            : "passing";
  return { state, totalCount: latest.size, passedCount, failedCount, pendingCount };
}

function assembleReview(raw: GitHubPullRequestView): PullRequestReview {
  const requested = raw.reviewRequestCount > 0;
  const state =
    raw.reviewDecision === "APPROVED"
      ? "approved"
      : raw.reviewDecision === "CHANGES_REQUESTED"
        ? "changes_requested"
        : raw.reviewDecision === "REVIEW_REQUIRED"
          ? requested
            ? "review_requested"
            : "review_required"
          : requested
            ? "review_requested"
            : "none";
  return { state, reviewRequestCount: raw.reviewRequestCount };
}

function assembleMergeability(raw: GitHubPullRequestView): PullRequestMergeability {
  const status = raw.mergeStateStatus;
  const state =
    raw.mergeable === "CONFLICTING" || status === "DIRTY"
      ? "conflicts"
      : raw.state === "OPEN" && raw.isDraft
        ? "draft"
        : status === "BLOCKED" || status === "BEHIND" || status === "HAS_HOOKS"
          ? "blocked"
          : raw.mergeable === "MERGEABLE" || status === "CLEAN"
            ? "mergeable"
            : "unknown";
  return { state, mergeStateStatus: status, mergeable: raw.mergeable };
}

function attention(
  state: PullRequest["state"],
  checks: PullRequestChecks,
  review: PullRequestReview,
  mergeability: PullRequestMergeability,
): PullRequestAttentionState {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  if (mergeability.state === "conflicts") return "conflicts";
  if (checks.state === "failing") return "checks_failed";
  if (review.state === "changes_requested") return "changes_requested";
  if (state === "draft") return "draft";
  if (review.state === "review_requested" || review.state === "review_required")
    return "review_requested";
  if (checks.state === "pending") return "checks_pending";
  if (mergeability.state === "blocked") return "blocked";
  if (mergeability.state === "mergeable" && checks.state === "passing") return "ready_to_merge";
  return "none";
}

export function assemblePullRequest(raw: GitHubPullRequestView): PullRequest {
  const state =
    raw.state === "MERGED"
      ? "merged"
      : raw.state === "CLOSED"
        ? "closed"
        : raw.isDraft
          ? "draft"
          : "open";
  const checks = assembleChecks(raw.checks);
  const review = assembleReview(raw);
  const mergeability = assembleMergeability(raw);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    updatedAt: raw.updatedAt,
    autoMerge: raw.autoMerge,
    inMergeQueue: null,
    checks,
    review,
    mergeability,
    attention: attention(state, checks, review, mergeability),
  };
}
