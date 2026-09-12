// Host bridge for GitHub subscription polling. These methods run in the
// plugin's host entry so `gh` execs inside the bound environment's checkout
// with the host user's own gh auth — no token is read, stored, or forwarded
// by the plugin. The engine in initiative-subscriptions.ts consumes the
// typed results; the zod schemas here are the wire contract.
//
// Pagination: `gh pr view --json` caps nested collections at ~100 and never
// returns inline review comments, and `gh run list --limit` silently drops
// runs beyond the cap. Both are replaced by manual `gh api` pagination over
// the REST list endpoints, bounded per endpoint by GH_MAX_PAGES — exceeding
// the bound returns an explicit error rather than silently skipping items.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { GH_PR_JSON_FIELDS } from "./initiative-subscriptions.ts";

const execFileAsync = promisify(execFile);

const REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

export const githubCiRunsInputSchema = z.object({
  /** Checkout directory the gh command runs in. */
  cwd: z.string().min(1),
  repo: z.string().regex(REPO_PATTERN, "expected owner/repo"),
  branch: z.string().min(1).optional(),
});

export const githubPrActivityInputSchema = z.object({
  cwd: z.string().min(1),
  repo: z.string().regex(REPO_PATTERN, "expected owner/repo"),
  pr: z.number().int().positive(),
});

const githubErrorSchema = z.object({ ok: z.literal(false), error: z.string() });

const githubCiRunSchema = z.object({
  databaseId: z.number(),
  attempt: z.number().optional().default(1),
  name: z.string().default(""),
  displayTitle: z.string().default(""),
  status: z.string().default(""),
  conclusion: z.string().nullable().default(null),
  event: z.string().default(""),
  headBranch: z.string().default(""),
  url: z.string().default(""),
  updatedAt: z.string().default(""),
});

export const githubCiRunsOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), runs: z.array(githubCiRunSchema) }),
  githubErrorSchema,
]);

const githubAuthorSchema = z.object({ login: z.string() }).nullable().default(null);

const githubPrSnapshotSchema = z.object({
  number: z.number(),
  title: z.string().default(""),
  url: z.string().default(""),
  state: z.string().default(""),
  mergedAt: z.string().nullable().default(null),
  comments: z
    .array(
      z.object({
        id: z.string(),
        author: githubAuthorSchema,
        body: z.string().default(""),
        createdAt: z.string().default(""),
      }),
    )
    .default([]),
  reviews: z
    .array(
      z.object({
        id: z.string(),
        author: githubAuthorSchema,
        body: z.string().default(""),
        state: z.string().default(""),
        submittedAt: z.string().default(""),
      }),
    )
    .default([]),
  reviewComments: z
    .array(
      z.object({
        id: z.string(),
        author: githubAuthorSchema,
        body: z.string().default(""),
        createdAt: z.string().default(""),
        path: z.string().default(""),
        line: z.number().nullable().default(null),
        inReplyToId: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export const githubPrActivityOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: githubPrSnapshotSchema }),
  githubErrorSchema,
]);

/** Contract fragment — spread into gtdSidebarHostContract in host-contract.ts. */
export const gitHubHostContract = {
  githubCiRuns: {
    input: githubCiRunsInputSchema,
    output: githubCiRunsOutputSchema,
  },
  githubPrActivity: {
    input: githubPrActivityInputSchema,
    output: githubPrActivityOutputSchema,
  },
} as const;

export type GitHubCiRunsInput = z.infer<typeof githubCiRunsInputSchema>;
export type GitHubPrActivityInput = z.infer<typeof githubPrActivityInputSchema>;
export type GitHubCiRunsOutput = z.infer<typeof githubCiRunsOutputSchema>;
export type GitHubPrActivityOutput = z.infer<typeof githubPrActivityOutputSchema>;

const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
/** REST page size and hard bound per list endpoint. */
const GH_PAGE_SIZE = 100;
const GH_MAX_PAGES = 10;
/** CI scan window: runs created in the last 7 days (reruns included). */
const CI_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Exec seam — host passes the real promisified execFile, tests inject a fake. */
export type GhExec = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    maxBuffer: number;
    signal: AbortSignal;
    timeout: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

function ghFailure(error: unknown): string {
  if (error instanceof Error) {
    const execError = error as Error & { stderr?: string; code?: number | string };
    const stderr = typeof execError.stderr === "string" ? execError.stderr.trim() : "";
    const detail = stderr || execError.message;
    if (execError.code === "ENOENT") {
      return "gh CLI not found on this host — install and authenticate GitHub CLI";
    }
    return detail.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

async function ghJson(
  exec: GhExec,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<unknown> {
  const { stdout } = await exec("gh", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GH_MAX_BUFFER,
    signal,
    timeout: GH_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
}

interface GhListOptions {
  /** Extra query terms appended to the endpoint (e.g. `&branch=main`). */
  params?: string;
  /** Extract the item array from a page payload; bare-array default. */
  unwrap?: (data: unknown) => unknown[];
  /**
   * Stop paginating when a page's LAST item satisfies this. For endpoints
   * ordered newest-first (actions/runs) this implements the scan window.
   */
  stopWhen?: (item: unknown) => boolean;
  /** Noun used in the truncation error, e.g. "PR comments". */
  itemName: string;
}

/**
 * Paginate a REST list endpoint under `repos/{repo}/{path}`. Returns every
 * item up to the page bound or the stopWhen predicate; hitting the bound is
 * an honest error, never a silent drop.
 */
async function ghApiList(
  exec: GhExec,
  cwd: string,
  repo: string,
  path: string,
  signal: AbortSignal,
  options: GhListOptions,
): Promise<{ ok: true; items: unknown[] } | { ok: false; error: string }> {
  const unwrap = options.unwrap ?? ((data: unknown) => (Array.isArray(data) ? data : []));
  const items: unknown[] = [];
  for (let page = 1; page <= GH_MAX_PAGES; page++) {
    const endpoint =
      `repos/${repo}/${path}?per_page=${GH_PAGE_SIZE}&page=${page}` + (options.params ?? "");
    let data: unknown;
    try {
      data = await ghJson(exec, ["api", endpoint], cwd, signal);
    } catch (error) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      return { ok: false, error: ghFailure(error) };
    }
    const pageItems = unwrap(data);
    items.push(...pageItems);
    if (pageItems.length < GH_PAGE_SIZE) return { ok: true, items };
    const last = pageItems[pageItems.length - 1];
    if (options.stopWhen && last !== undefined && options.stopWhen(last)) {
      return { ok: true, items };
    }
  }
  return {
    ok: false,
    error: `${options.itemName} exceed the ${GH_MAX_PAGES * GH_PAGE_SIZE}-item bound — narrow the subscription scope`,
  };
}

function ghUser(value: unknown): { login: string } | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { login?: unknown }).login === "string"
  ) {
    return { login: (value as { login: string }).login };
  }
  return null;
}

function ghString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `actions/runs` — every workflow run created inside the 7-day window,
 * paginated. The window also captures in-window reruns: a rerun bumps
 * run_attempt and updated_at while keeping its original created_at.
 */
export async function execGitHubCiRuns(
  input: GitHubCiRunsInput,
  signal: AbortSignal,
  exec: GhExec = execFileAsync,
  now: number = Date.now(),
): Promise<GitHubCiRunsOutput> {
  const cutoff = now - CI_RUN_WINDOW_MS;
  const list = await ghApiList(exec, input.cwd, input.repo, "actions/runs", signal, {
    params: input.branch ? `&branch=${encodeURIComponent(input.branch)}` : "",
    unwrap: (data) => {
      const runs = (data as { workflow_runs?: unknown }).workflow_runs;
      return Array.isArray(runs) ? runs : [];
    },
    stopWhen: (item) =>
      Date.parse(ghString((item as { created_at?: unknown }).created_at)) < cutoff,
    itemName: "CI runs in the 7-day window",
  });
  if (!list.ok) return list;
  const runs = (list.items as Record<string, unknown>[]).map((run) => ({
    databaseId: typeof run.id === "number" ? run.id : 0,
    attempt: typeof run.run_attempt === "number" ? run.run_attempt : 1,
    name: ghString(run.name),
    displayTitle: ghString(run.display_title),
    status: ghString(run.status),
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    event: ghString(run.event),
    headBranch: ghString(run.head_branch),
    url: ghString(run.html_url),
    updatedAt: ghString(run.updated_at),
  }));
  const parsed = githubCiRunsOutputSchema.safeParse({ ok: true, runs });
  if (!parsed.success) return { ok: false, error: "unexpected actions/runs output" };
  return parsed.data;
}

/**
 * PR activity — scalar fields from `gh pr view`, plus three paginated REST
 * lists: conversation comments, review submissions, and inline review
 * comments (which `gh pr view` cannot return at all).
 */
export async function execGitHubPrActivity(
  input: GitHubPrActivityInput,
  signal: AbortSignal,
  exec: GhExec = execFileAsync,
): Promise<GitHubPrActivityOutput> {
  let view: unknown;
  try {
    view = await ghJson(
      exec,
      ["pr", "view", String(input.pr), "--repo", input.repo, "--json", GH_PR_JSON_FIELDS],
      input.cwd,
      signal,
    );
  } catch (error) {
    if (signal.aborted) return { ok: false, error: "aborted" };
    return { ok: false, error: ghFailure(error) };
  }
  const comments = await ghApiList(
    exec,
    input.cwd,
    input.repo,
    `issues/${input.pr}/comments`,
    signal,
    { itemName: "PR comments" },
  );
  if (!comments.ok) return comments;
  const reviews = await ghApiList(
    exec,
    input.cwd,
    input.repo,
    `pulls/${input.pr}/reviews`,
    signal,
    { itemName: "PR reviews" },
  );
  if (!reviews.ok) return reviews;
  const reviewComments = await ghApiList(
    exec,
    input.cwd,
    input.repo,
    `pulls/${input.pr}/comments`,
    signal,
    { itemName: "PR review comments" },
  );
  if (!reviewComments.ok) return reviewComments;
  const snapshot = {
    ...(view as Record<string, unknown>),
    comments: (comments.items as Record<string, unknown>[]).map((comment) => ({
      id: String(comment.id),
      author: ghUser(comment.user),
      body: ghString(comment.body),
      createdAt: ghString(comment.created_at),
    })),
    reviews: (reviews.items as Record<string, unknown>[]).map((review) => ({
      id: String(review.id),
      author: ghUser(review.user),
      body: ghString(review.body),
      state: ghString(review.state),
      submittedAt: ghString(review.submitted_at),
    })),
    reviewComments: (reviewComments.items as Record<string, unknown>[]).map((comment) => ({
      id: String(comment.id),
      author: ghUser(comment.user),
      body: ghString(comment.body),
      createdAt: ghString(comment.created_at),
      path: ghString(comment.path),
      line: typeof comment.line === "number" ? comment.line : null,
      inReplyToId: comment.in_reply_to_id != null ? String(comment.in_reply_to_id) : null,
    })),
  };
  const parsed = githubPrActivityOutputSchema.safeParse({ ok: true, snapshot });
  if (!parsed.success) return { ok: false, error: "unexpected PR activity output" };
  return parsed.data;
}
