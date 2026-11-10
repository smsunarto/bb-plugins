/**
 * The review page's GitHub reads: an account's inbox (what it opened, what
 * it is asked to review), and a pull request's files, patches and commits.
 * Exec-injected and Effect-free, like `github.ts`.
 */
import type { Commit, FilePatch, PullRequest } from "../core/change.ts";
import type { Repo } from "../core/ids.ts";
import type { ChangeFile, ForgeFile, InboxEntry } from "../core/review.ts";
import { classifyFailure, GhError, type Exec } from "./github.ts";

export type { InboxEntry };

const INBOX_LIMIT = 50;

const PR_FIELDS = `
  ... on PullRequest {
    number url title state isDraft updatedAt headRefName baseRefName headRefOid
    mergeable reviewDecision additions deletions changedFiles
    commitCount: commits { totalCount }
    author { login }
    repository { name owner { login } }
    headRepositoryOwner { login }
    latestOpinionatedReviews(first: 20) { nodes { state } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 0) {
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
    } } } } }
  }`;

/** Both lists in one call, so an inbox costs one request per account. */
const INBOX = `query($mine: String!, $asked: String!) {
  mine: search(query: $mine, type: ISSUE, first: ${INBOX_LIMIT}) { nodes { ${PR_FIELDS} } }
  asked: search(query: $asked, type: ISSUE, first: ${INBOX_LIMIT}) { nodes { ${PR_FIELDS} } }
}`;

type CountByState = { state?: string; count?: number };
type InboxNode = {
  number?: number;
  url?: string;
  title?: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  isDraft?: boolean;
  updatedAt?: string;
  headRefName?: string;
  baseRefName?: string;
  headRefOid?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitCount?: { totalCount?: number };
  author?: { login?: string } | null;
  repository?: { name?: string; owner?: { login?: string } };
  headRepositoryOwner?: { login?: string } | null;
  latestOpinionatedReviews?: { nodes?: ({ state?: string } | null)[] } | null;
  commits?: {
    nodes?: {
      commit?: {
        statusCheckRollup?: {
          contexts?: {
            checkRunCountsByState?: CountByState[];
            statusContextCountsByState?: CountByState[];
          };
        } | null;
      };
    }[];
  };
};

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "ERROR",
]);

/** Check runs and statuses counted by state, as the pull request's check counts. */
export function countByState(counts: readonly CountByState[]): PullRequest["checks"] {
  const checks = { passed: 0, failed: 0, pending: 0 };
  for (const { state = "", count = 0 } of counts) {
    if (PASSED.has(state)) checks.passed += count;
    else if (FAILED.has(state)) checks.failed += count;
    else checks.pending += count;
  }
  return checks;
}

const REVIEW = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
} as const;
const MERGEABLE = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
} as const;

type CompleteNode = InboxNode & { number: number; url: string; headRefOid: string };

/** The search hit as the model's pull request. */
function pullRequestOf(node: CompleteNode): PullRequest {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  return {
    number: node.number,
    url: node.url,
    title: node.title ?? "",
    state: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open",
    isDraft: node.isDraft === true,
    headRefOid: node.headRefOid,
    baseRef: node.baseRefName ?? "",
    reviewDecision: node.reviewDecision ? REVIEW[node.reviewDecision] : null,
    approvals: (node.latestOpinionatedReviews?.nodes ?? []).filter(
      (review) => review?.state === "APPROVED",
    ).length,
    mergeable: MERGEABLE[node.mergeable ?? "UNKNOWN"],
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    commits: node.commitCount?.totalCount ?? 0,
    checks: countByState([
      ...(contexts?.checkRunCountsByState ?? []),
      ...(contexts?.statusContextCountsByState ?? []),
    ]),
  };
}

function entryOf(node: InboxNode, list: "mine" | "asked"): InboxEntry | null {
  const owner = node.repository?.owner?.login;
  const name = node.repository?.name;
  if (!node.number || !node.url || !owner || !name || !node.headRefName || !node.headRefOid)
    return null;
  return {
    repo: { owner: owner.toLowerCase(), name: name.toLowerCase() },
    headOwner: (node.headRepositoryOwner?.login ?? owner).toLowerCase(),
    branch: node.headRefName,
    author: node.author?.login ?? null,
    updatedAt: node.updatedAt ?? null,
    mine: list === "mine",
    asked: list === "asked",
    pullRequest: pullRequestOf(node as CompleteNode),
  };
}

async function graphql<T>(exec: Exec, query: string, variables: object, signal?: AbortSignal) {
  const result = await exec(["api", "graphql", "--input", "-"], {
    stdin: JSON.stringify({ query, variables }),
    signal,
  });
  let parsed: { data?: T; errors?: { message?: string; type?: string }[] } | undefined;
  try {
    parsed = result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  const error = parsed?.errors?.[0];
  if (error) {
    const code =
      error.type === "RATE_LIMITED"
        ? "rate-limited"
        : error.type === "FORBIDDEN"
          ? "forbidden"
          : "failed";
    throw new GhError(code, error.message ?? "GitHub GraphQL request failed.");
  }
  if (result.code !== 0 || !parsed?.data) throw classifyFailure(result);
  return parsed.data;
}

/**
 * The account's open pull requests: the ones it opened and the ones it is
 * asked to review, newest first, one entry per pull request.
 */
export async function readInbox(exec: Exec, signal?: AbortSignal): Promise<InboxEntry[]> {
  const data = await graphql<{
    mine?: { nodes?: (InboxNode | null)[] };
    asked?: { nodes?: (InboxNode | null)[] };
  }>(
    exec,
    INBOX,
    {
      mine: "is:pr is:open archived:false author:@me sort:updated-desc",
      asked: "is:pr is:open archived:false review-requested:@me sort:updated-desc",
    },
    signal,
  );
  const byUrl = new Map<string, InboxEntry>();
  for (const list of ["mine", "asked"] as const)
    for (const node of data[list]?.nodes ?? []) {
      const entry = node ? entryOf(node, list) : null;
      if (!entry) continue;
      const seen = byUrl.get(entry.pullRequest.url);
      byUrl.set(
        entry.pullRequest.url,
        seen ? { ...seen, mine: seen.mine || entry.mine, asked: seen.asked || entry.asked } : entry,
      );
    }
  return [...byUrl.values()];
}

/** GitHub's REST file statuses as the model's kinds. */
const FILE_KINDS: Record<string, ChangeFile["kind"]> = {
  added: "added",
  removed: "deleted",
  modified: "modified",
  changed: "modified",
  renamed: "renamed",
  copied: "copied",
  unchanged: "modified",
};

type RestFile = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  previous_filename?: string;
};

/** GitHub lists at most this many files of a pull request. */
export const FORGE_MAX_FILES = 3000;

async function restPages<T>(exec: Exec, path: string, signal?: AbortSignal): Promise<T[]> {
  const result = await exec(["api", "--paginate", "--slurp", path], { signal });
  if (result.code !== 0) throw classifyFailure(result);
  try {
    return (JSON.parse(result.stdout) as T[][]).flat();
  } catch {
    throw new GhError("failed", "GitHub returned a page that could not be read.");
  }
}

const filesPath = (repo: Repo, number: number) =>
  `repos/${repo.owner}/${repo.name}/pulls/${number}/files?per_page=100`;

/** The pull request's files with their hunks as GitHub has them: one call, every page. */
export async function readPullRequestFiles(
  exec: Exec,
  repo: Repo,
  number: number,
  signal?: AbortSignal,
): Promise<ForgeFile[]> {
  const pages = await restPages<RestFile>(exec, filesPath(repo, number), signal);
  return pages.flatMap((raw) => {
    if (!raw.filename) return [];
    const kind = FILE_KINDS[raw.status ?? ""] ?? "modified";
    const previousPath = raw.previous_filename ?? null;
    const file: ChangeFile = {
      path: raw.filename,
      kind,
      previousPath,
      additions: raw.additions ?? 0,
      deletions: raw.deletions ?? 0,
      // GitHub sends no hunks for a binary file, nor for one past its size limit.
      binary: raw.patch === undefined && (raw.additions ?? 0) + (raw.deletions ?? 0) === 0,
    };
    return [{ file, patch: raw.patch === undefined ? null : gitPatch(file, raw.patch) }];
  });
}

/** GitHub's bare hunks wrapped in the git header Pierre parses. */
export function gitPatch(file: ChangeFile, hunks: string): FilePatch {
  const before = file.previousPath ?? file.path;
  const header = [
    `diff --git a/${before} b/${file.path}`,
    ...(file.kind === "renamed" ? [`rename from ${before}`, `rename to ${file.path}`] : []),
    file.kind === "added" ? "--- /dev/null" : `--- a/${before}`,
    file.kind === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}`,
  ];
  const body = hunks.endsWith("\n") ? hunks : `${hunks}\n`;
  return {
    path: file.path,
    kind: file.kind,
    previousPath: file.previousPath,
    patch: `${header.join("\n")}\n${body}`,
    truncated: false,
  };
}

type RestCommit = {
  sha?: string;
  commit?: {
    message?: string;
    author?: { date?: string } | null;
    committer?: { date?: string } | null;
  };
};

/** The pull request's commits, newest first as the model lists them. */
export async function readPullRequestCommits(
  exec: Exec,
  repo: Repo,
  number: number,
  signal?: AbortSignal,
): Promise<Commit[]> {
  const pages = await restPages<RestCommit>(
    exec,
    `repos/${repo.owner}/${repo.name}/pulls/${number}/commits?per_page=100`,
    signal,
  );
  return pages
    .flatMap((raw) =>
      raw.sha
        ? [
            {
              id: raw.sha,
              subject: (raw.commit?.message ?? "").split("\n")[0] ?? "",
              createdAt: raw.commit?.author?.date ?? raw.commit?.committer?.date ?? null,
              conflicted: false,
            },
          ]
        : [],
    )
    .toReversed();
}

/** The review page's GitHub reads, as one closed union a host can run too. */
export type ReviewRead =
  | { kind: "inbox" }
  | { kind: "files"; repo: Repo; number: number }
  | { kind: "commits"; repo: Repo; number: number };
export type ReviewAnswer =
  | { kind: "inbox"; entries: InboxEntry[] }
  | { kind: "files"; files: ForgeFile[] }
  | { kind: "commits"; commits: Commit[] };

export async function runReviewRead(
  exec: Exec,
  read: ReviewRead,
  signal?: AbortSignal,
): Promise<ReviewAnswer> {
  switch (read.kind) {
    case "inbox":
      return { kind: "inbox", entries: await readInbox(exec, signal) };
    case "files":
      return {
        kind: "files",
        files: await readPullRequestFiles(exec, read.repo, read.number, signal),
      };
    case "commits":
      return {
        kind: "commits",
        commits: await readPullRequestCommits(exec, read.repo, read.number, signal),
      };
  }
}
