// The GitHub CLI, invoked from the plugin backend.
//
// This is what makes verification independent of the agent: SlopCop reads PR
// and comment state itself rather than trusting a transcript. Mirrors the
// official github plugin's execFile approach.
import type { ChildProcess } from "node:child_process";
import { experimental_execHostFileCallback as execFile } from "@get-bb/plugin-sdk/process";
import { Data, Effect, Predicate, Result } from "effect";
import type { GitHubIssue, PullRequest, TriggerComment, TriggerCommentSource } from "./types";

/**
 * What a failed `gh` call says about reaching GitHub: the account is signed
 * out, GitHub is out of reach, or neither.
 */
export type GhFailureReason = "unauthenticated" | "unavailable" | "failed";

export class GhError extends Data.TaggedError("GhError")<{
  message: string;
  reason: GhFailureReason;
}> {}

/** GitHub could not be reached, so whether `gh` is signed in is still unknown. */
export class GhUnavailable extends Data.TaggedError("GhUnavailable")<{ message: string }> {}

// PR data comes from the REST API, not `gh pr list --json`: the CLI's JSON
// surface has no `authorAssociation` field, and that is precisely what the
// trust gate is built on. REST omits the changed-file list, so files are
// fetched separately and only when a rule actually needs them.
export interface GhClient {
  listOpenPullRequests(repo: string): Effect.Effect<PullRequest[], GhError>;
  getPullRequest(repo: string, number: number): Effect.Effect<PullRequest, GhError>;
  listOpenIssueNumbers(repo: string): Effect.Effect<number[], GhError>;
  getIssue(repo: string, number: number): Effect.Effect<GitHubIssue, GhError>;
  listFiles(repo: string, number: number): Effect.Effect<{ path: string }[], GhError>;
  listIssueComments(repo: string, number: number): Effect.Effect<GhComment[], GhError>;
  listReviewComments(repo: string, number: number): Effect.Effect<GhComment[], GhError>;
  listReviews(repo: string, number: number): Effect.Effect<GhComment[], GhError>;
  listRecentIssueComments(repo: string, since: number): Effect.Effect<TriggerComment[], GhError>;
  listRecentReviewComments(repo: string, since: number): Effect.Effect<TriggerComment[], GhError>;
  /**
   * The account `gh` acts as, or null when it is signed out or the lookup
   * failed for another reason. Fails only when GitHub is out of reach, which
   * a later attempt can outlast.
   */
  authenticatedLogin(): Effect.Effect<string | null, GhUnavailable>;
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

// What `gh` and the bot wrapper print when the account is signed out, and when
// the network or GitHub is down. `gh` names the cause only in its output.
const UNAUTHENTICATED =
  /no oauth token|not logged in|gh auth login|authentication required|bad credentials|HTTP 401|failed \(401\)/i;
const UNAVAILABLE =
  /error connecting to|could not resolve host|no such host|connection refused|connection reset|network is unreachable|host is unreachable|timeout|timed out|deadline exceeded|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|HTTP 5\d\d|failed \(5\d\d\)/i;

/** Reads a failed call's output. A call its own timeout killed did not reach GitHub in time. */
function failureReason(output: string, timedOut: boolean): GhFailureReason {
  if (UNAUTHENTICATED.test(output)) return "unauthenticated";
  if (timedOut || UNAVAILABLE.test(output)) return "unavailable";
  return "failed";
}

/** How long a stop waits for a killed `gh` to exit; bb's other plugins allow the same. */
const KILL_GRACE_MS = 2_000;

/**
 * Runs `gh` and returns its stdout. Interrupting the call kills `gh`, then
 * waits up to KILL_GRACE_MS for it to exit, so a stop never leaves it running.
 */
function run(file: string, args: string[], timeoutMs: number): Effect.Effect<string, GhError> {
  return Effect.callback<string, GhError>((resume, signal) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed(stdout));
          return;
        }
        const detail = stderr.trim() || error.message;
        resume(
          Effect.fail(
            new GhError({
              message: `gh ${args.slice(0, 3).join(" ")} failed: ${detail}`,
              reason: failureReason(detail, error.killed === true),
            }),
          ),
        );
      },
    );
    return exited(child).pipe(Effect.timeoutOption(KILL_GRACE_MS), Effect.asVoid);
  });
}

function exited(child: ChildProcess): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) resume(Effect.void);
    else child.once("exit", () => resume(Effect.void));
  });
}

function toTimestamp(value: unknown): number {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return Predicate.isObject(value) ? value : {};
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
  const call = (args: string[]) => run(ghPath, args, timeoutMs);
  const apiRows = (endpoint: string): Effect.Effect<unknown[], GhError> =>
    // --jq emits one compact JSON row per line across all pages, including on
    // Ubuntu's older gh releases that do not implement --slurp.
    call(["api", "--paginate", endpoint, "--jq", ".[]"]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as unknown),
      ),
    );
  const api = (endpoint: string) =>
    apiRows(endpoint).pipe(Effect.map((rows) => rows.map(toComment)));
  const recentComments = (repo: string, source: TriggerCommentSource, since: number) => {
    const path = source === "issue" ? "issues/comments" : "pulls/comments";
    return apiRows(
      `repos/${repo}/${path}?sort=updated&direction=asc&since=${new Date(since).toISOString()}&per_page=100`,
    ).pipe(
      Effect.map((rows) =>
        rows.map((raw): TriggerComment => {
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
        }),
      ),
    );
  };

  return {
    listOpenPullRequests: (repo) =>
      apiRows(`repos/${repo}/pulls?state=open&per_page=100`).pipe(
        Effect.map((rows) => rows.map(toPullRequest)),
      ),

    getPullRequest: (repo, number) =>
      call(["api", `repos/${repo}/pulls/${number}`]).pipe(
        Effect.map((stdout) => toPullRequest(JSON.parse(stdout))),
      ),

    listOpenIssueNumbers: (repo) =>
      call([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number",
      ]).pipe(Effect.map((stdout) => toIssueNumbers(JSON.parse(stdout)))),

    getIssue: (repo, number) =>
      call(["api", `repos/${repo}/issues/${number}`]).pipe(
        Effect.flatMap((stdout) => {
          const issue = toIssue(JSON.parse(stdout));
          return issue === null
            ? Effect.fail(
                new GhError({
                  message: `${repo}#${number} is a pull request, not an issue`,
                  reason: "failed",
                }),
              )
            : Effect.succeed(issue);
        }),
      ),

    listFiles: (repo, number) =>
      apiRows(`repos/${repo}/pulls/${number}/files?per_page=100`).pipe(
        Effect.map((rows) => rows.map((row) => ({ path: String(asRecord(row).filename ?? "") }))),
      ),

    listIssueComments: (repo, number) => api(`repos/${repo}/issues/${number}/comments`),
    listReviewComments: (repo, number) => api(`repos/${repo}/pulls/${number}/comments`),
    listReviews: (repo, number) => api(`repos/${repo}/pulls/${number}/reviews`),
    listRecentIssueComments: (repo, since) => recentComments(repo, "issue", since),
    listRecentReviewComments: (repo, since) => recentComments(repo, "review", since),

    authenticatedLogin: Effect.fnUntraced(function* () {
      const asUser = yield* Effect.result(call(["api", "user", "--jq", ".login"]));
      if (Result.isSuccess(asUser)) return asUser.success.trim() || null;
      // A GitHub App installation token has no `GET /user` — it is not a
      // user — so a bot deployment always lands here. Returning null would
      // silently disarm the account guard in `verifyLive`, which then counts
      // anyone's comment as possibly ours. A bot wrapper answers this
      // instead; plain `gh` fails it harmlessly and we fall through.
      const asBot = yield* Effect.result(call(["slopcop-login"]));
      if (Result.isSuccess(asBot)) return asBot.success.trim() || null;
      // Only an outage is worth waiting out. A signed-out `gh`, or one that
      // failed for a reason neither lookup names, needs the operator.
      const failures = [asUser.failure, asBot.failure];
      const outage = failures.find((failure) => failure.reason === "unavailable");
      if (
        outage === undefined ||
        failures.some((failure) => failure.reason === "unauthenticated")
      ) {
        return null;
      }
      return yield* new GhUnavailable({ message: outage.message });
    }),
  };
}
