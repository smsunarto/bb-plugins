/**
 * GitHub reads for a watched pull request and for work a thread landed.
 * Exec-injected and Effect-free, so the server and a checkout's host run the
 * same code. Ported from `plugins/code-review/src/server/lib/{pr-watch,landed,checks}.ts`.
 */
import type {
  CommitRef,
  Landed,
  PrHead,
  PrRef,
  PrState,
  WatchCheck,
  WatchRead,
} from "../core/watch.ts";
import { classifyFailure, GhError, type Exec } from "./github.ts";
import { graphql } from "./review.ts";

/** Below this many GraphQL points left, watches wait for the hourly reset. */
const LOW_RATE_LIMIT = 250;
/** CI and deploy bots report through checks, so their comments are status, not news. */
const STATUS_BOTS = ["github-actions", "vercel", "netlify", "railway", "cloudflare"];

const WATCH_QUERY = `query PrWatch($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining resetAt }
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url title state baseRefName mergeStateStatus headRefOid
      comments(last: 100) { nodes { id url author { login } } }
      reviews(last: 100) { nodes { id url state body author { login } } }
      reviewThreads(last: 100) {
        nodes { path line comments(last: 20) { nodes { id url author { login } } } }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

type GqlActor = { login: string } | null;
type GqlItem = { id: string; url: string; author: GqlActor };
type GqlContext =
  | {
      __typename: "CheckRun";
      databaseId: number;
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
    }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };

type GqlWatch = {
  rateLimit: { remaining: number; resetAt: string } | null;
  viewer: { login: string };
  repository: {
    pullRequest: {
      url: string;
      title: string;
      state: string;
      baseRefName: string;
      mergeStateStatus: string | null;
      headRefOid: string;
      comments: { nodes: GqlItem[] };
      reviews: { nodes: (GqlItem & { state: string; body: string })[] };
      reviewThreads: {
        nodes: { path: string; line: number | null; comments: { nodes: GqlItem[] } }[];
      };
      commits: {
        nodes: {
          commit: { statusCheckRollup: { contexts: { nodes: (GqlContext | null)[] } } | null };
        }[];
      };
    } | null;
  } | null;
};

export function prState(state: string): PrState {
  return state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open";
}

const CONCLUSIONS: Record<string, WatchCheck["state"]> = {
  SUCCESS: "success",
  FAILURE: "failure",
  TIMED_OUT: "failure",
  STARTUP_FAILURE: "failure",
  ACTION_REQUIRED: "failure",
  NEUTRAL: "neutral",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
  STALE: "cancelled",
};
const STATUSES: Record<string, WatchCheck["state"]> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
};

function watchCheck(node: GqlContext): WatchCheck {
  if (node.__typename === "StatusContext")
    return {
      id: `status:${node.context}`,
      name: node.context,
      state: STATUSES[node.state] ?? "neutral",
      detailsUrl: node.targetUrl || null,
    };
  return {
    id: `run:${node.databaseId}`,
    name: node.name,
    state:
      node.status === "COMPLETED" ? (CONCLUSIONS[node.conclusion ?? ""] ?? "neutral") : "pending",
    detailsUrl: node.detailsUrl || null,
  };
}

const REVIEW_VERDICTS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
};

/** The pull request's state, its head's checks, and the conversation on it from someone other than the viewer. */
export async function readWatch(exec: Exec, ref: PrRef, signal?: AbortSignal): Promise<WatchRead> {
  const data = await graphql<GqlWatch>(
    exec,
    WATCH_QUERY,
    { owner: ref.owner, name: ref.repo, number: ref.number },
    signal,
  );
  const pr = data.repository?.pullRequest;
  if (!pr)
    throw new GhError(
      "not-found",
      `GitHub has no pull request ${ref.owner}/${ref.repo}#${ref.number}.`,
    );
  const viewer = data.viewer.login.toLowerCase();
  const login = (item: GqlItem) => item.author?.login ?? "ghost";
  const fromOthers = (item: GqlItem) => login(item).toLowerCase() !== viewer;
  const statusBot = (item: GqlItem) =>
    STATUS_BOTS.some((bot) => login(item).toLowerCase().includes(bot));
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return {
    url: pr.url,
    title: pr.title,
    state: prState(pr.state),
    baseRefName: pr.baseRefName,
    mergeState: pr.mergeStateStatus,
    checks: {
      headRefOid: pr.headRefOid,
      checks: contexts.flatMap((node) => (node ? [watchCheck(node)] : [])),
    },
    activity: [
      ...pr.comments.nodes
        .filter((item) => fromOthers(item) && !statusBot(item))
        .map((item) => ({ id: item.id, line: `Comment from ${login(item)}: ${item.url}` })),
      // A review that only carries inline comments has no body: its comments are the news.
      ...pr.reviews.nodes
        .filter((item) => fromOthers(item) && (REVIEW_VERDICTS[item.state] || item.body.trim()))
        .map((item) => ({
          id: item.id,
          line: `Review from ${login(item)}${REVIEW_VERDICTS[item.state] ? ` (${REVIEW_VERDICTS[item.state]})` : ""}: ${item.url}`,
        })),
      ...pr.reviewThreads.nodes.flatMap((thread) =>
        thread.comments.nodes.filter(fromOthers).map((item) => ({
          id: item.id,
          line: `Review comment from ${login(item)} on ${thread.path}${thread.line ? `:${thread.line}` : ""}: ${item.url}`,
        })),
      ),
    ].slice(-500),
    pausedUntil:
      data.rateLimit && data.rateLimit.remaining < LOW_RATE_LIMIT
        ? Date.parse(data.rateLimit.resetAt)
        : null,
  };
}

const LANDED_PR_QUERY = `query LandedPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { url title state } }
}`;

type RestCommit = { sha: string; html_url: string; commit: { message: string } };
type RestCompare = { ahead_by: number; merge_base_commit: RestCommit; commits: RestCommit[] };

async function rest<T>(exec: Exec, path: string, signal?: AbortSignal): Promise<T> {
  const result = await exec(["api", path], { signal });
  if (result.code !== 0 || result.failure) throw classifyFailure(result);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new GhError("failed", "GitHub returned an answer that could not be read.");
  }
}

/** Names the reference a failed read was about, keeping what kind of failure it was. */
function about(key: string) {
  return (error: unknown): never => {
    const message = `${key}: ${error instanceof Error ? error.message : String(error)}`;
    throw error instanceof GhError ? new GhError(error.code, message) : new Error(message);
  };
}

const repoPath = (owner: string, repo: string) =>
  `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/** Whether each pull request merged and each commit is on its repository's default branch, as GitHub reports now. */
export async function readLanded(
  exec: Exec,
  { prs, commits }: { prs: readonly PrRef[]; commits: readonly CommitRef[] },
  signal?: AbortSignal,
): Promise<Landed> {
  const branches = new Map<string, Promise<string>>();
  const defaultBranch = (owner: string, repo: string) => {
    const key = `${owner}/${repo}`.toLowerCase();
    let branch = branches.get(key);
    if (!branch) {
      branch = rest<{ default_branch: string }>(exec, repoPath(owner, repo), signal).then(
        (repository) => repository.default_branch,
      );
      branches.set(key, branch);
    }
    return branch;
  };
  const readPr = async (ref: PrRef) => {
    const data = await graphql<{
      repository: { pullRequest: { url: string; title: string; state: string } | null } | null;
    }>(exec, LANDED_PR_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number }, signal);
    const pr = data.repository?.pullRequest;
    if (!pr) throw new GhError("not-found", "GitHub has no such pull request.");
    return { ref, title: pr.title, url: pr.url, state: prState(pr.state) };
  };
  const readCommit = async (ref: CommitRef) => {
    const branch = await defaultBranch(ref.owner, ref.repo);
    // From the branch's tip to the commit: nothing ahead means the branch holds it.
    const compare = await rest<RestCompare>(
      exec,
      `${repoPath(ref.owner, ref.repo)}/compare/${encodeURIComponent(branch)}...${ref.sha}`,
      signal,
    );
    const landed = compare.ahead_by === 0;
    const commit = landed
      ? compare.merge_base_commit
      : compare.commits.find((each) => each.sha.startsWith(ref.sha));
    return {
      ref: { ...ref, sha: commit?.sha ?? ref.sha },
      branch,
      landed,
      headline: commit?.commit.message.split("\n", 1)[0] ?? null,
      url: commit?.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/commit/${ref.sha}`,
    };
  };
  const [prStates, commitStates] = await Promise.all([
    Promise.all(
      prs.map((ref) => readPr(ref).catch(about(`${ref.owner}/${ref.repo}#${ref.number}`))),
    ),
    Promise.all(
      commits.map((ref) => readCommit(ref).catch(about(`${ref.owner}/${ref.repo}@${ref.sha}`))),
    ),
  ]);
  return { prs: prStates, commits: commitStates };
}

const PR_HEAD_QUERY = `query PrHead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefName headRefOid headRepositoryOwner { login } }
  }
}`;

/** The branch a pull request comes from: what names its Change. */
export async function readPrHead(exec: Exec, ref: PrRef, signal?: AbortSignal): Promise<PrHead> {
  const data = await graphql<{
    repository: {
      pullRequest: {
        headRefName: string;
        headRefOid: string;
        headRepositoryOwner: { login: string } | null;
      } | null;
    } | null;
  }>(exec, PR_HEAD_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number }, signal);
  const pr = data.repository?.pullRequest;
  if (!pr) throw new GhError("not-found", "GitHub has no such pull request.");
  return {
    branch: pr.headRefName,
    head: pr.headRefOid,
    headOwner: pr.headRepositoryOwner?.login ?? ref.owner,
  };
}
