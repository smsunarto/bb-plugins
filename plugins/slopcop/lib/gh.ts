// The GitHub CLI, invoked from the plugin backend.
//
// This is what makes verification independent of the agent: SlopCop reads PR
// and comment state itself rather than trusting a transcript. Mirrors the
// official github plugin's execFile approach.
import { execFile } from "node:child_process";
import type { GitHubIssue, PullRequest, TriggerComment, TriggerCommentSource } from "./types";

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GhError";
  }
}

// PR data comes from the REST API, not `gh pr list --json`: the CLI's JSON
// surface has no `authorAssociation` field, and that is precisely what the
// trust gate is built on. REST omits the changed-file list, so files are
// fetched separately and only when a rule actually needs them.
export interface GhClient {
  listOpenPullRequests(repo: string): Promise<PullRequest[]>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  listOpenIssueNumbers(repo: string): Promise<number[]>;
  getIssue(repo: string, number: number): Promise<GitHubIssue>;
  listFiles(repo: string, number: number): Promise<{ path: string }[]>;
  listIssueComments(repo: string, number: number): Promise<GhComment[]>;
  listReviewComments(repo: string, number: number): Promise<GhComment[]>;
  listReviews(repo: string, number: number): Promise<GhComment[]>;
  listRecentIssueComments(repo: string, since: number): Promise<TriggerComment[]>;
  listRecentReviewComments(repo: string, since: number): Promise<TriggerComment[]>;
  authenticatedLogin(): Promise<string | null>;
}

export interface GhComment {
  id: string;
  body: string;
  url: string | null;
  author: string | null;
  path: string | null;
  line: number | null;
  createdAt: number;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GhError(
              `gh ${args.slice(0, 3).join(" ")} failed: ${stderr.trim() || error.message}`,
              stderr,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function toTimestamp(value: unknown): number {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Normalizes the three differently-shaped comment endpoints into one type. */
function toComment(raw: unknown): GhComment {
  const row = asRecord(raw);
  const user = asRecord(row.user);
  return {
    id: String(row.id ?? ""),
    body: typeof row.body === "string" ? row.body : "",
    url: typeof row.html_url === "string" ? row.html_url : null,
    author: typeof user.login === "string" ? user.login : null,
    path: typeof row.path === "string" ? row.path : null,
    line:
      typeof row.line === "number"
        ? row.line
        : typeof row.original_line === "number"
          ? row.original_line
          : null,
    createdAt: toTimestamp(row.submitted_at ?? row.created_at),
  };
}

/** Maps a REST pull-request object onto the fields SlopCop evaluates. */
export function toPullRequest(raw: unknown): PullRequest {
  const row = asRecord(raw);
  const head = asRecord(row.head);
  const base = asRecord(row.base);
  const headRepo = asRecord(head.repo);
  const baseRepo = asRecord(base.repo);
  const labels = Array.isArray(row.labels) ? row.labels : [];
  return {
    kind: "pull_request",
    number: typeof row.number === "number" ? row.number : 0,
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    createdAt: toTimestamp(row.created_at),
    isDraft: row.draft === true,
    headRefOid: typeof head.sha === "string" ? head.sha : "",
    baseRefName: typeof base.ref === "string" ? base.ref : "",
    author: { login: String(asRecord(row.user).login ?? "") },
    authorAssociation:
      typeof row.author_association === "string"
        ? (row.author_association as PullRequest["authorAssociation"])
        : "NONE",
    labels: labels.map((label) => ({
      name: String(asRecord(label).name ?? ""),
    })),
    // Populated on demand — REST does not return the file list inline.
    files: [],
    isCrossRepository:
      typeof headRepo.full_name === "string" &&
      typeof baseRepo.full_name === "string" &&
      headRepo.full_name !== baseRepo.full_name,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

/** Maps a REST issue object and excludes pull requests from issue listings. */
export function toIssue(raw: unknown): GitHubIssue | null {
  const row = asRecord(raw);
  if (row.pull_request !== undefined) return null;
  const labels = Array.isArray(row.labels) ? row.labels : [];
  return {
    kind: "issue",
    number: typeof row.number === "number" ? row.number : 0,
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    author: { login: String(asRecord(row.user).login ?? "") },
    authorAssociation:
      typeof row.author_association === "string"
        ? (row.author_association as GitHubIssue["authorAssociation"])
        : "NONE",
    labels: labels.map((label) => ({
      name: String(asRecord(label).name ?? ""),
    })),
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

export function toIssueNumbers(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const number = asRecord(value).number;
    return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? [number] : [];
  });
}

export function createGhClient(ghPath: string, timeoutMs = 30_000): GhClient {
  const apiRows = async (endpoint: string): Promise<unknown[]> => {
    const stdout = await run(ghPath, ["api", "--paginate", "--slurp", endpoint], timeoutMs);
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
  };
  const api = async (endpoint: string): Promise<GhComment[]> =>
    (await apiRows(endpoint)).map(toComment);
  const recentComments = async (
    repo: string,
    source: TriggerCommentSource,
    since: number,
  ): Promise<TriggerComment[]> => {
    const path = source === "issue" ? "issues/comments" : "pulls/comments";
    const rows = await apiRows(
      `repos/${repo}/${path}?sort=updated&direction=asc&since=${new Date(since).toISOString()}&per_page=100`,
    );
    return rows.map((raw) => {
      const row = asRecord(raw);
      const user = asRecord(row.user);
      const prUrl = source === "issue" ? row.issue_url : row.pull_request_url;
      const match = typeof prUrl === "string" ? prUrl.match(/\/(\d+)$/) : null;
      return {
        id: String(row.id ?? ""),
        source,
        repo,
        prNumber: match === null ? 0 : Number.parseInt(match[1]!, 10),
        body: typeof row.body === "string" ? row.body : "",
        url: typeof row.html_url === "string" ? row.html_url : null,
        author: typeof user.login === "string" ? user.login : null,
        authorAssociation:
          typeof row.author_association === "string" ? row.author_association : "NONE",
        createdAt: toTimestamp(row.created_at),
        updatedAt: toTimestamp(row.updated_at ?? row.created_at),
      };
    });
  };

  return {
    async listOpenPullRequests(repo) {
      const rows = await apiRows(`repos/${repo}/pulls?state=open&per_page=100`);
      return rows.map(toPullRequest);
    },

    async getPullRequest(repo, number) {
      const stdout = await run(ghPath, ["api", `repos/${repo}/pulls/${number}`], timeoutMs);
      return toPullRequest(JSON.parse(stdout));
    },

    async listOpenIssueNumbers(repo) {
      const stdout = await run(
        ghPath,
        ["issue", "list", "--repo", repo, "--state", "open", "--limit", "1000", "--json", "number"],
        timeoutMs,
      );
      return toIssueNumbers(JSON.parse(stdout));
    },

    async getIssue(repo, number) {
      const stdout = await run(ghPath, ["api", `repos/${repo}/issues/${number}`], timeoutMs);
      const issue = toIssue(JSON.parse(stdout));
      if (issue === null) {
        throw new Error(`${repo}#${number} is a pull request, not an issue`);
      }
      return issue;
    },

    async listFiles(repo, number) {
      const rows = await apiRows(`repos/${repo}/pulls/${number}/files?per_page=100`);
      return rows.map((row) => ({
        path: String(asRecord(row).filename ?? ""),
      }));
    },

    listIssueComments: (repo, number) => api(`repos/${repo}/issues/${number}/comments`),
    listReviewComments: (repo, number) => api(`repos/${repo}/pulls/${number}/comments`),
    listReviews: (repo, number) => api(`repos/${repo}/pulls/${number}/reviews`),
    listRecentIssueComments: (repo, since) => recentComments(repo, "issue", since),
    listRecentReviewComments: (repo, since) => recentComments(repo, "review", since),

    async authenticatedLogin() {
      try {
        const stdout = await run(ghPath, ["api", "user", "--jq", ".login"], timeoutMs);
        return stdout.trim() || null;
      } catch {
        // A GitHub App installation token has no `GET /user` — it is not a
        // user — so a bot deployment always lands here. Returning null would
        // silently disarm the account guard in `verifyLive`, which then counts
        // anyone's comment as possibly ours. A bot wrapper answers this
        // instead; plain `gh` fails it harmlessly and we fall through.
        try {
          const stdout = await run(ghPath, ["slopcop-login"], timeoutMs);
          return stdout.trim() || null;
        } catch {
          return null;
        }
      }
    },
  };
}
