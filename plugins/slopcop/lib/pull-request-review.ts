// One pull request's SlopCop review state, as other plugins see it.
//
// Reads only the local store, so a Review rail can render it without waiting
// on GitHub. Whether the rule still matches the PR is a GitHub question and is
// left to the re-run itself.
import type { Store } from "./db";
import type { Rule, Run } from "./types";

export type PullRequestReviewState = "none" | "running" | "done" | "failed";

export interface PullRequestReview {
  state: PullRequestReviewState;
  finishedAt: string | null;
  findings: number;
  canRunAgain: boolean;
  reason: string | null;
}

/** A run that has not recorded its outcome yet, including one under verification. */
export function isRunning(run: Run): boolean {
  return run.status === "dispatched" || run.status === "reviewing";
}

function reviewsPullRequests(rule: Rule): boolean {
  return rule.enabled && rule.triggers.some((trigger) => trigger !== "new_issue");
}

/** GitHub matches repository names without regard to case; rules keep the case they were saved with. */
export function canonicalRepo(store: Store, repo: string): string {
  const lower = repo.toLowerCase();
  return store.listRules().find((rule) => rule.repo.toLowerCase() === lower)?.repo ?? repo;
}

/**
 * The rule a re-run dispatches: the one that last reviewed the PR while it is
 * still enabled, otherwise the first enabled rule for the repo that reviews
 * pull requests. Returns why there is none instead.
 */
export function rerunRule(
  store: Store,
  repo: string,
  latest: Run | null,
): { rule: Rule } | { reason: string } {
  const previous = latest === null ? null : store.getRule(latest.ruleId);
  const rule =
    previous !== null && reviewsPullRequests(previous)
      ? previous
      : (store
          .listRules()
          .find((candidate) => candidate.repo === repo && reviewsPullRequests(candidate)) ?? null);
  if (rule === null) {
    return { reason: `No enabled SlopCop rule reviews pull requests in ${repo}.` };
  }
  if (rule.request === null) {
    return {
      reason: `The SlopCop rule "${rule.name}" has no agent configured. Open it in the SlopCop panel and save it once.`,
    };
  }
  return { rule };
}

export function pullRequestReview(store: Store, repo: string, number: number): PullRequestReview {
  const canonical = canonicalRepo(store, repo);
  const runs = store.listPullRequestRuns(canonical, number);
  // A rule still reviewing outranks a newer run of another rule that finished.
  const latest = runs.find(isRunning) ?? runs[0] ?? null;
  if (latest !== null && isRunning(latest)) {
    return {
      state: "running",
      finishedAt: null,
      findings: 0,
      canRunAgain: false,
      reason: "A SlopCop review of this pull request is already running.",
    };
  }
  const choice = rerunRule(store, canonical, latest);
  const rerun =
    "rule" in choice ? { canRunAgain: true, reason: null } : { canRunAgain: false, ...choice };
  if (latest === null) {
    return { state: "none", finishedAt: null, findings: 0, ...rerun };
  }
  return {
    state: latest.status === "failed" ? "failed" : "done",
    finishedAt: latest.finishedAt === null ? null : new Date(latest.finishedAt).toISOString(),
    findings: store.listComments(latest.id).filter((comment) => comment.kind === "inline").length,
    ...rerun,
  };
}
