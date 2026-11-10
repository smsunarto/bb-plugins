/**
 * GitHub through the `gh` CLI, for whichever site runs it: the bb server or a
 * checkout's host. The caller injects `exec`, so the same reads run at both
 * sites and in tests. Effect-free; failures are typed `GhError`s.
 *
 * Classification and auth parsing are ported from
 * `plugins/code-review/src/server/lib/gh.ts`.
 */
import type { PullRequest, ForgeValue } from "../core/change.ts";
import type { Repo } from "../core/ids.ts";

export type GhErrorCode =
  | "gh-missing"
  | "unauthenticated"
  | "not-found"
  | "forbidden"
  | "rate-limited"
  | "failed";

export class GhError extends Error {
  readonly code: GhErrorCode;
  constructor(code: GhErrorCode, message: string) {
    super(message);
    this.name = "GhError";
    this.code = code;
  }
}

/** How a `gh` run ended. `code` 127 with ENOENT means gh is not installed. */
export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  failure?: "timeout" | "too-large";
};

/** Runs `gh args`, writing `stdin` when given. Never rejects for a non-zero exit. */
export type Exec = (
  args: readonly string[],
  options: { stdin?: string; signal?: AbortSignal },
) => Promise<RunResult>;

const NO_CREDENTIALS =
  /no oauth token|not logged in|gh auth login|authentication required|bad credentials|HTTP 401/i;
const NOT_FOUND = /HTTP 404|could not resolve to a|not found/i;
const FORBIDDEN = /HTTP 403|resource not accessible|must have (?:push|admin|write)/i;
const RATE_LIMITED = /rate limit|HTTP 429|secondary rate/i;

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  ).replace(/^gh: /, "");
}

/** Maps a failed `gh` invocation to a typed error with a message a person can act on. */
export function classifyFailure(result: RunResult): GhError {
  if (result.code === 127 && /ENOENT/.test(result.stderr)) {
    return new GhError("gh-missing", "GitHub CLI (gh) is not installed.");
  }
  if (result.failure === "timeout") return new GhError("failed", "GitHub CLI timed out.");
  if (result.failure === "too-large")
    return new GhError("failed", "GitHub returned too much data.");
  const text = `${result.stderr}\n${result.stdout}`.trim();
  const message =
    firstLine(result.stderr) || firstLine(result.stdout) || "gh failed with no output.";
  if (NO_CREDENTIALS.test(text))
    return new GhError("unauthenticated", "GitHub CLI is not signed in. Run `gh auth login`.");
  if (RATE_LIMITED.test(text)) return new GhError("rate-limited", message);
  if (FORBIDDEN.test(text)) return new GhError("forbidden", message);
  if (NOT_FOUND.test(text)) return new GhError("not-found", message);
  return new GhError("failed", message);
}

const ACCOUNT =
  /(Logged|Failed to log) in to github\.com (?:account|as) ([A-Za-z0-9][A-Za-z0-9_-]*)(?: \(([^)]*)\))?/;
const ACTIVE = /Active account: (true|false)/;

/**
 * The signed-in github.com logins in `gh auth status` output, the active one
 * first. An account whose token stopped working ("Failed to log in") is left out.
 */
export function parseAuthStatus(text: string): string[] {
  const accounts: { login: string; active: boolean }[] = [];
  let current: { login: string; active: boolean } | null = null;
  for (const line of text.split("\n")) {
    const opened = ACCOUNT.exec(line);
    if (opened) {
      current = opened[1] === "Logged" ? { login: opened[2] ?? "", active: true } : null;
      if (current) accounts.push(current);
    }
    const active = ACTIVE.exec(line)?.[1];
    if (active && current) current.active = active === "true";
  }
  return accounts.toSorted((a, b) => Number(b.active) - Number(a.active)).map(({ login }) => login);
}

/** The logins `gh` is signed in as here. Empty when it is installed but signed out. */
export async function readAccounts(exec: Exec, signal?: AbortSignal): Promise<string[]> {
  const result = await exec(["auth", "status", "--hostname", "github.com"], { signal });
  if (result.code === 127 || result.failure) throw classifyFailure(result);
  // gh exits non-zero when any account fails, and older versions print to stderr.
  return parseAuthStatus(`${result.stdout}\n${result.stderr}`);
}

const PULL_REQUESTS = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number url title state isDraft headRefOid baseRefName reviewDecision
        headRepositoryOwner { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { status conclusion }
          ... on StatusContext { state }
        } } } } } }
      }
    }
  }
}`;

type CheckNode = {
  __typename?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};
type PullRequestNode = {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headRepositoryOwner: { login: string } | null;
  commits?: {
    nodes?: {
      commit?: { statusCheckRollup?: { contexts?: { nodes?: (CheckNode | null)[] } } | null };
    }[];
  };
};

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "ERROR",
]);

/** Pass, fail and pending counts across check runs and commit statuses. */
export function countChecks(nodes: readonly (CheckNode | null)[]): PullRequest["checks"] {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const node of nodes) {
    if (!node) continue;
    const outcome =
      node.__typename === "StatusContext"
        ? node.state
        : node.status === "COMPLETED"
          ? node.conclusion
          : null;
    if (outcome && PASSING.has(outcome)) counts.passed++;
    else if (outcome && FAILING.has(outcome)) counts.failed++;
    else counts.pending++;
  }
  return counts;
}

const REVIEW: Record<
  NonNullable<PullRequestNode["reviewDecision"]>,
  PullRequest["reviewDecision"]
> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
};

function toPullRequest(node: PullRequestNode): PullRequest {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return {
    number: node.number,
    url: node.url,
    title: node.title,
    state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
    isDraft: node.isDraft,
    headRefOid: node.headRefOid,
    baseRef: node.baseRefName,
    reviewDecision: node.reviewDecision ? REVIEW[node.reviewDecision] : null,
    checks: countChecks(contexts),
  };
}

/**
 * The pull request of `headOwner`'s `branch` in `repo`: the open one if any,
 * else the most recently updated. Null when the branch has none, which is an
 * answer, not a failure.
 */
export function pickPullRequest(nodes: readonly PullRequestNode[], headOwner: string): ForgeValue {
  const own = nodes.filter(
    (node) => node.headRepositoryOwner?.login.toLowerCase() === headOwner.toLowerCase(),
  );
  const chosen = own.find((node) => node.state === "OPEN") ?? own[0];
  return chosen ? toPullRequest(chosen) : null;
}

export type PullRequestQuery = { repo: Repo; headOwner: string; branch: string };

export async function readPullRequest(
  exec: Exec,
  query: PullRequestQuery,
  signal?: AbortSignal,
): Promise<ForgeValue> {
  const body = JSON.stringify({
    query: PULL_REQUESTS,
    variables: { owner: query.repo.owner, name: query.repo.name, branch: query.branch },
  });
  const result = await exec(["api", "graphql", "--input", "-"], { stdin: body, signal });
  let parsed:
    | {
        data?: { repository?: { pullRequests?: { nodes?: (PullRequestNode | null)[] } } | null };
        errors?: { message?: string; type?: string }[];
      }
    | undefined;
  try {
    parsed = result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  const error = parsed?.errors?.[0];
  if (error) {
    const code: GhErrorCode =
      error.type === "NOT_FOUND"
        ? "not-found"
        : error.type === "FORBIDDEN"
          ? "forbidden"
          : error.type === "RATE_LIMITED"
            ? "rate-limited"
            : "failed";
    throw new GhError(code, error.message ?? "GitHub GraphQL request failed.");
  }
  if (result.code !== 0 || !parsed?.data) throw classifyFailure(result);
  const nodes = (parsed.data.repository?.pullRequests?.nodes ?? []).filter(
    (node): node is PullRequestNode => node !== null,
  );
  return pickPullRequest(nodes, query.headOwner);
}
