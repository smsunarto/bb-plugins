/**
 * Pull requests of GitButler branches, read with `gh pr view <branch>` in the
 * checkout on its own machine, so its remotes and `gh` login apply. Forked
 * from bb's bundled GitHub PR Status host, which reads only the checked-out
 * branch: `gitbutler/workspace` in a GitButler checkout.
 */
import {
  gitHubPullRequestViewSchema,
  type GitHubPullRequestCheck,
  type GitHubPullRequestView,
  type HostPullRequestLookup,
  type PullRequestAction,
} from "../shared/pull-request.ts";
import { GhMissingError, runGh } from "./cli.ts";

const VIEW_FIELDS = [
  "number",
  "title",
  "state",
  "url",
  "isDraft",
  "autoMergeRequest",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "updatedAt",
  "statusCheckRollup",
  "reviewDecision",
  "reviewRequests",
  "mergeStateStatus",
  "mergeable",
].join(",");

/** Lookups one read runs at once. Each is a GitHub API call. */
const CONCURRENCY = 4;

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(json: Json, key: string): string | null {
  const value = json[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function upper(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | null {
  const normalized = upper(value);
  return options.find((option) => option === normalized) ?? null;
}

function checkStatus(value: unknown): GitHubPullRequestCheck["status"] {
  switch (upper(value)) {
    case "QUEUED":
    case "REQUESTED":
    case "WAITING":
      return "queued";
    case "EXPECTED":
    case "IN_PROGRESS":
    case "PENDING":
      return "in_progress";
    case "COMPLETED":
    case "SUCCESS":
    case "FAILURE":
    case "ERROR":
    case "CANCELLED":
    case "SKIPPED":
    case "NEUTRAL":
      return "completed";
    default:
      return "unknown";
  }
}

const CONCLUSIONS = [
  "SUCCESS",
  "CANCELLED",
  "SKIPPED",
  "NEUTRAL",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "UNKNOWN",
] as const;

function checkConclusion(value: unknown): GitHubPullRequestCheck["conclusion"] {
  const normalized = upper(value);
  if (normalized === "FAILURE" || normalized === "ERROR") return "failure";
  const match = CONCLUSIONS.find((option) => option === normalized);
  return match ? (match.toLowerCase() as GitHubPullRequestCheck["conclusion"]) : null;
}

function checks(value: unknown): GitHubPullRequestCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const check = object(item);
    if (!check) return [];
    const startedAt = text(check, "startedAt") ?? text(check, "createdAt");
    return [
      {
        // Check runs have a name; commit statuses a context.
        name:
          text(check, "name") ??
          text(check, "context") ??
          text(check, "workflowName") ??
          "Unnamed check",
        status: checkStatus(check["status"] ?? check["state"]),
        conclusion: checkConclusion(check["conclusion"]) ?? checkConclusion(check["state"]),
        startedAt: startedAt !== null && !Number.isNaN(Date.parse(startedAt)) ? startedAt : null,
      },
    ];
  });
}

/** `gh pr view --json` output as a view, or null when it is not one. */
export function parsePullRequestView(stdout: string): GitHubPullRequestView | null {
  let json: Json | null;
  try {
    json = object(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (!json) return null;
  const requests = json["reviewRequests"];
  const parsed = gitHubPullRequestViewSchema.safeParse({
    number: json["number"],
    title: json["title"],
    state: upper(json["state"]),
    url: json["url"],
    isDraft: json["isDraft"],
    autoMerge: object(json["autoMergeRequest"]) !== null,
    baseRefName: json["baseRefName"],
    headRefName: json["headRefName"],
    headRefOid: typeof json["headRefOid"] === "string" ? json["headRefOid"] : null,
    updatedAt: json["updatedAt"],
    checks: checks(json["statusCheckRollup"]),
    reviewDecision: oneOf(json["reviewDecision"], [
      "APPROVED",
      "CHANGES_REQUESTED",
      "REVIEW_REQUIRED",
    ] as const),
    reviewRequestCount: Array.isArray(requests) ? requests.length : 0,
    mergeStateStatus: oneOf(json["mergeStateStatus"], [
      "BEHIND",
      "BLOCKED",
      "CLEAN",
      "DIRTY",
      "DRAFT",
      "HAS_HOOKS",
      "UNKNOWN",
      "UNSTABLE",
    ] as const),
    mergeable: oneOf(json["mergeable"], ["CONFLICTING", "MERGEABLE", "UNKNOWN"] as const),
  });
  return parsed.success ? parsed.data : null;
}

function firstLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "")
      ?.slice(0, 500) ?? ""
  );
}

const NO_PULL_REQUEST = /no pull requests found for branch/i;

/** The pull request `gh` finds for `branch` in the checkout at `cwd`. */
export async function lookupBranch(
  cwd: string,
  branch: string,
  signal: AbortSignal,
): Promise<HostPullRequestLookup> {
  try {
    // `--` keeps a branch name that starts with a dash from reading as a flag.
    const result = await runGh(cwd, ["pr", "view", "--json", VIEW_FIELDS, "--", branch], signal);
    if (result.code === 0) {
      const pullRequest = parsePullRequestView(result.stdout);
      return pullRequest
        ? { outcome: "found", pullRequest }
        : { outcome: "unavailable", message: "gh pr view returned an unreadable pull request." };
    }
    if (NO_PULL_REQUEST.test(result.stderr)) return { outcome: "none" };
    return {
      outcome: "unavailable",
      message: firstLine(result.stderr) || firstLine(result.stdout) || "gh pr view failed.",
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      outcome: "unavailable",
      message: error instanceof GhMissingError ? error.message : String(error),
    };
  }
}

/** Each branch's lookup, a few at a time. */
export async function lookupBranches(
  cwd: string,
  branches: readonly string[],
  signal: AbortSignal,
): Promise<Record<string, HostPullRequestLookup>> {
  const results: Record<string, HostPullRequestLookup> = {};
  let next = 0;
  const worker = async () => {
    while (next < branches.length) {
      const branch = branches[next++]!;
      results[branch] = await lookupBranch(cwd, branch, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, branches.length) }, worker));
  return results;
}

/** `gh` arguments for `action` on the pull request at `url`, which pins its repository. */
function actionArgs(action: PullRequestAction, url: string, head: string | null): string[] {
  const target = url;
  switch (action.operation) {
    case "ready":
      return ["pr", "ready", target];
    case "draft":
      return ["pr", "ready", target, "--undo"];
    case "merge":
      // GitHub refuses the merge if the branch moved past the commit the reader saw.
      return [
        "pr",
        "merge",
        target,
        `--${action.method}`,
        ...(head ? ["--match-head-commit", head] : []),
      ];
  }
}

/** Runs `action` on the pull request at `url`, saying why it failed when it did. */
export async function actOnPullRequest(
  cwd: string,
  url: string,
  head: string | null,
  action: PullRequestAction,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const args = actionArgs(action, url, head);
  try {
    const result = await runGh(cwd, args, signal);
    if (result.code === 0) return { ok: true };
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      ok: false,
      message: detail ? `gh ${args.join(" ")} failed: ${detail}` : `gh ${args.join(" ")} failed`,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Why `input`'s action must not run on `pullRequest`, the branch's pull
 * request read just now: it is not the one the reader saw, it moved since,
 * or it is not in a state the action applies to.
 */
export function refusalOf(
  pullRequest: GitHubPullRequestView,
  input: {
    branch: string;
    action: PullRequestAction;
    expectedUrl: string;
    expectedHeadOid: string | null;
  },
): string | null {
  const { branch, action, expectedUrl, expectedHeadOid } = input;
  const label = `Pull request #${pullRequest.number}`;
  const open = pullRequest.state === "OPEN";
  if (pullRequest.url !== expectedUrl)
    return `${branch} now has pull request ${pullRequest.url}, not ${expectedUrl}. Check it and try again.`;
  switch (action.operation) {
    case "ready":
      return open && pullRequest.isDraft ? null : `${label} is not a draft.`;
    case "draft":
      return open && !pullRequest.isDraft ? null : `${label} is not open for review.`;
    case "merge":
      if (expectedHeadOid !== null && pullRequest.headRefOid !== expectedHeadOid)
        return `${label} has new commits since it was shown. Check them and try again.`;
      return open && !pullRequest.isDraft ? null : `${label} is not open for merging.`;
  }
}
