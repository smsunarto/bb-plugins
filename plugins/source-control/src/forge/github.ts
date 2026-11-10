/**
 * GitHub through the `gh` CLI, for whichever site runs it: the bb server or a
 * checkout's host. The caller injects `exec`, so the same reads run at both
 * sites and in tests. Effect-free; failures are typed `GhError`s.
 *
 * Classification and auth parsing are ported from
 * `plugins/code-review/src/server/lib/gh.ts`.
 */
import type { CheckRow, ForgeRead, ForgeResult, ForgeThread, PullRequest } from "../core/change.ts";
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
  options: { stdin?: string; signal?: AbortSignal; env?: Readonly<Record<string, string>> },
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

/** How many checks one read brings; GitHub has more only on unusually large suites. */
const CHECK_LIMIT = 100;
/** Review threads and comments per thread one read brings; a longer review shows its first ones. */
const THREAD_LIMIT = 100;
const THREAD_COMMENT_LIMIT = 30;

const PULL_REQUESTS = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number url title state isDraft headRefOid baseRefName reviewDecision
        mergeable additions deletions changedFiles commitCount: commits { totalCount }
        headRepositoryOwner { login }
        latestOpinionatedReviews(first: 50) { nodes { state } }
        reviewThreads(first: ${THREAD_LIMIT}) { nodes {
          id path line startLine originalLine diffSide isResolved isOutdated
          comments(first: ${THREAD_COMMENT_LIMIT}) { nodes { id body createdAt url author { __typename login } } }
        } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${CHECK_LIMIT}) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun {
              name status conclusion detailsUrl startedAt completedAt
              checkSuite { workflowRun { workflow { name } } }
            }
            ... on StatusContext { context state targetUrl createdAt }
          }
        } } } } }
      }
    }
  }
}`;

type CheckNode = {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
  createdAt?: string | null;
};
type ThreadNode = {
  id?: string;
  path?: string;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  diffSide?: "LEFT" | "RIGHT";
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: {
    nodes?: ({
      id?: string;
      body?: string;
      createdAt?: string;
      url?: string;
      author?: { __typename?: string; login?: string } | null;
    } | null)[];
  };
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
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitCount?: { totalCount?: number };
  headRepositoryOwner: { login: string } | null;
  latestOpinionatedReviews?: { nodes?: ({ state?: string } | null)[] } | null;
  reviewThreads?: { nodes?: (ThreadNode | null)[] } | null;
  commits?: {
    nodes?: {
      commit?: {
        statusCheckRollup?: {
          contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: (CheckNode | null)[] };
        } | null;
      };
    }[];
  };
};

const PASSING = new Set(["SUCCESS"]);
const SKIPPED = new Set(["NEUTRAL", "SKIPPED"]);
const FAILING = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "ERROR",
]);

/** A check's result as an outcome: anything not reported yet is pending. */
function outcomeOf(result: string | null | undefined): CheckRow["outcome"] {
  if (!result) return "pending";
  if (PASSING.has(result)) return "passed";
  if (SKIPPED.has(result)) return "skipped";
  return FAILING.has(result) ? "failed" : "pending";
}

/** A check run or commit status as a row. */
export function checkRow(node: CheckNode): CheckRow {
  if (node.__typename === "StatusContext")
    return {
      name: node.context ?? "Status",
      workflow: null,
      outcome: outcomeOf(node.state),
      url: node.targetUrl ?? null,
      startedAt: node.createdAt ?? null,
      completedAt: null,
    };
  return {
    name: node.name ?? "Check",
    workflow: node.checkSuite?.workflowRun?.workflow?.name ?? null,
    outcome: outcomeOf(node.status === "COMPLETED" ? node.conclusion : null),
    url: node.detailsUrl ?? null,
    startedAt: node.startedAt ?? null,
    completedAt: node.completedAt ?? null,
  };
}

/** Pass, fail and pending counts across check runs and commit statuses. */
export function countChecks(rows: readonly CheckRow[]): PullRequest["checks"] {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    if (row.outcome === "failed") counts.failed++;
    else if (row.outcome === "pending") counts.pending++;
    else counts.passed++;
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

const MERGEABLE = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
} as const satisfies Record<string, PullRequest["mergeable"]>;

const positive = (value: number | null | undefined) =>
  typeof value === "number" && value > 0 ? value : null;

/** A review thread as stored; a deleted author is GitHub's "ghost". */
export function toThread(node: ThreadNode): ForgeThread | null {
  if (!node.id || !node.path) return null;
  return {
    id: node.id,
    path: node.path,
    line: positive(node.line),
    startLine: positive(node.startLine),
    originalLine: positive(node.originalLine),
    side: node.diffSide === "LEFT" ? "LEFT" : "RIGHT",
    isResolved: node.isResolved === true,
    isOutdated: node.isOutdated === true,
    comments: (node.comments?.nodes ?? []).flatMap((comment) =>
      comment?.id
        ? [
            {
              id: comment.id,
              author: comment.author?.login ?? "ghost",
              bot: comment.author?.__typename === "Bot",
              body: comment.body ?? "",
              createdAt: comment.createdAt ?? "",
              url: comment.url ?? null,
            },
          ]
        : [],
    ),
  };
}

function toRead(node: PullRequestNode): ForgeRead {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const rows = (contexts?.nodes ?? []).flatMap((check) => (check ? [checkRow(check)] : []));
  const approvals = (node.latestOpinionatedReviews?.nodes ?? []).filter(
    (review) => review?.state === "APPROVED",
  ).length;
  return {
    pullRequest: {
      number: node.number,
      url: node.url,
      title: node.title,
      state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
      isDraft: node.isDraft,
      headRefOid: node.headRefOid,
      baseRef: node.baseRefName,
      reviewDecision: node.reviewDecision ? REVIEW[node.reviewDecision] : null,
      approvals,
      mergeable: MERGEABLE[node.mergeable ?? "UNKNOWN"],
      additions: node.additions ?? 0,
      deletions: node.deletions ?? 0,
      changedFiles: node.changedFiles ?? 0,
      commits: node.commitCount?.totalCount ?? 0,
      checks: countChecks(rows),
    },
    checks: { head: node.headRefOid, rows, more: contexts?.pageInfo?.hasNextPage === true },
    threads: (node.reviewThreads?.nodes ?? []).flatMap((thread) => {
      const value = thread ? toThread(thread) : null;
      return value ? [value] : [];
    }),
  };
}

/**
 * The pull request of `headOwner`'s `branch` in `repo`: the open one if any,
 * else the most recently updated. Null when the branch has none, which is an
 * answer, not a failure.
 */
export function pickPullRequest(nodes: readonly PullRequestNode[], headOwner: string): ForgeRead {
  const own = nodes.filter(
    (node) => node.headRepositoryOwner?.login.toLowerCase() === headOwner.toLowerCase(),
  );
  const chosen = own.find((node) => node.state === "OPEN") ?? own[0];
  return chosen ? toRead(chosen) : { pullRequest: null, checks: null, threads: null };
}

export type PullRequestQuery = { repo: Repo; headOwner: string; branch: string };

function graphqlError(error: { message?: string; type?: string }): GhError {
  const code: GhErrorCode =
    error.type === "NOT_FOUND"
      ? "not-found"
      : error.type === "FORBIDDEN"
        ? "forbidden"
        : error.type === "RATE_LIMITED"
          ? "rate-limited"
          : "failed";
  return new GhError(code, error.message ?? "GitHub GraphQL request failed.");
}

export async function readPullRequest(
  exec: Exec,
  query: PullRequestQuery,
  signal?: AbortSignal,
): Promise<ForgeRead> {
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
  if (error) throw graphqlError(error);
  if (result.code !== 0 || !parsed?.data) throw classifyFailure(result);
  const nodes = (parsed.data.repository?.pullRequests?.nodes ?? []).filter(
    (node): node is PullRequestNode => node !== null,
  );
  return pickPullRequest(nodes, query.headOwner);
}

/** Marks the pull request draft, or ready for review. Throws a `GhError` when GitHub refuses. */
export async function setDraft(
  exec: Exec,
  target: { repo: Repo; number: number; draft: boolean },
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    "pr",
    "ready",
    String(target.number),
    "--repo",
    `${target.repo.owner}/${target.repo.name}`,
  ];
  const result = await exec(target.draft ? [...args, "--undo"] : args, { signal });
  if (result.code !== 0 || result.failure) throw classifyFailure(result);
}

/**
 * `exec` signed in as `login`. The active account needs nothing; another
 * account's token is asked of `gh` once and kept in memory for `ttlMs`, never
 * written anywhere.
 */
export function accountExec(
  exec: Exec,
  now: () => number,
  ttlMs = 5 * 60_000,
): (login: string, active: boolean) => Exec {
  const tokens = new Map<string, { token: string; at: number }>();
  return (login, active) => {
    if (active) return exec;
    return async (args, options) => {
      let known = tokens.get(login);
      if (!known || now() - known.at >= ttlMs) {
        const answer = await exec(
          ["auth", "token", "--hostname", "github.com", "--user", login],
          options.signal ? { signal: options.signal } : {},
        );
        const token = answer.stdout.trim();
        if (answer.code !== 0 || token === "") throw classifyFailure(answer);
        known = { token, at: now() };
        tokens.set(login, known);
      }
      return exec(args, { ...options, env: { ...options.env, GH_TOKEN: known.token } });
    };
  };
}

export type DraftWrite = PullRequestQuery & {
  number: number;
  draft: boolean;
  expectedHead: string;
};

/**
 * Marks the pull request draft or ready, only while its head is still
 * `expectedHead`. Convergent: a pull request already so is `upToDate`, so a
 * retry after a lost answer is safe.
 */
export async function setDraftAt(
  exec: Exec,
  write: DraftWrite,
  signal?: AbortSignal,
): Promise<ForgeResult> {
  const { pullRequest } = await readPullRequest(exec, write, signal);
  if (!pullRequest || pullRequest.number !== write.number || pullRequest.state !== "open")
    return {
      status: "conflict",
      detail: `#${write.number} is no longer this branch's open pull request.`,
    };
  if (pullRequest.headRefOid !== write.expectedHead)
    return {
      status: "conflict",
      detail: `#${write.number} moved to ${pullRequest.headRefOid.slice(0, 7)} since you looked.`,
    };
  if (pullRequest.isDraft === write.draft) return { status: "upToDate" };
  await setDraft(exec, { repo: write.repo, number: write.number, draft: write.draft }, signal);
  return { status: "done" };
}
