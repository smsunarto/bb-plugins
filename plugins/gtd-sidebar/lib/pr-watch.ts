/**
 * Hourly GitHub watch for snoozed threads.
 *
 * One GraphQL query covers every watched PR. The first observation is a
 * baseline, not a wake: otherwise the first hour would unsnooze everything
 * that already had comments. Later ticks compare a fingerprint of comments,
 * reviews, check rollup, and deployments.
 *
 * Rate limit: GitHub GraphQL is 5,000 points per hour. This query's cost
 * scales with the number of PRs, not with nested page size (each connection
 * is totalCount or last:1). Skip the tick when remaining points are too low
 * to pay for another run, and wait until GitHub's own reset rather than
 * retrying inside the hour.
 */

export const MAX_WATCHED_PRS = 80;
export const MAX_PR_BACKFILL_PER_TICK = 8;
export const MIN_RATE_LIMIT_REMAINING = 200;

export interface PrWatchSnapshot {
  nodeId: string;
  url: string;
  number: number;
  title: string;
  updatedAt: string;
  commentCount: number;
  reviewCount: number;
  reviewThreadCount: number;
  latestReviewState: string | null;
  latestReviewAuthor: string | null;
  checkRollup: string | null;
  latestDeployment: {
    createdAt: string;
    state: string;
    environment: string | null;
  } | null;
}

export interface PrWatchRateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
  limit: number;
}

export interface PrChange {
  kind: "comments" | "reviews" | "review-threads" | "checks" | "deployments" | "updated";
  text: string;
}

const GITHUB_PULL_URL =
  /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:\/.*)?(?:\?.*)?$/i;

export function canonicalPullRequestUrl(url: string): string | null {
  const match = url.trim().match(GITHUB_PULL_URL);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/i, "");
  const number = match[3];
  if (!owner || !repo || !number) return null;
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

export function fingerprintOf(snapshot: PrWatchSnapshot): string {
  return JSON.stringify({
    updatedAt: snapshot.updatedAt,
    commentCount: snapshot.commentCount,
    reviewCount: snapshot.reviewCount,
    reviewThreadCount: snapshot.reviewThreadCount,
    latestReviewState: snapshot.latestReviewState,
    checkRollup: snapshot.checkRollup,
    latestDeployment: snapshot.latestDeployment,
  });
}

export function diffSnapshots(previous: PrWatchSnapshot, next: PrWatchSnapshot): PrChange[] {
  const changes: PrChange[] = [];

  if (next.commentCount > previous.commentCount) {
    const added = next.commentCount - previous.commentCount;
    changes.push({
      kind: "comments",
      text: `${added} new comment${added === 1 ? "" : "s"}`,
    });
  }

  if (
    next.reviewCount > previous.reviewCount ||
    (next.latestReviewState !== null && next.latestReviewState !== previous.latestReviewState)
  ) {
    const who = next.latestReviewAuthor ? ` from ${next.latestReviewAuthor}` : "";
    const state = next.latestReviewState ?? "submitted";
    changes.push({
      kind: "reviews",
      text: `new review${who} (${state})`,
    });
  }

  if (next.reviewThreadCount > previous.reviewThreadCount) {
    const added = next.reviewThreadCount - previous.reviewThreadCount;
    changes.push({
      kind: "review-threads",
      text: `${added} new inline comment thread${added === 1 ? "" : "s"}`,
    });
  }

  if (next.checkRollup !== previous.checkRollup && next.checkRollup !== null) {
    const from = previous.checkRollup ?? "unknown";
    changes.push({
      kind: "checks",
      text: `checks ${from} → ${next.checkRollup}`,
    });
  }

  const prevDeploy = previous.latestDeployment;
  const nextDeploy = next.latestDeployment;
  if (
    nextDeploy !== null &&
    (prevDeploy === null ||
      nextDeploy.createdAt > prevDeploy.createdAt ||
      nextDeploy.state !== prevDeploy.state)
  ) {
    const env = nextDeploy.environment ? ` to ${nextDeploy.environment}` : "";
    changes.push({
      kind: "deployments",
      text: `deployment${env}: ${nextDeploy.state}`,
    });
  }

  if (changes.length === 0 && next.updatedAt !== previous.updatedAt) {
    changes.push({ kind: "updated", text: "PR updated on GitHub" });
  }

  return changes;
}

export function formatAgentWakeMessage(
  snapshot: PrWatchSnapshot,
  changes: readonly PrChange[],
): string {
  const lines = changes.map((change) => `- ${change.text}`);
  return [
    `GitHub pull request #${snapshot.number} changed while this thread was snoozed.`,
    snapshot.title.trim().length > 0 ? snapshot.title.trim() : null,
    snapshot.url,
    "",
    "What changed:",
    ...lines,
    "",
    "Please inspect the pull request and continue any work this update unblocks.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function shouldSkipForRateLimit(
  remaining: number | null,
  skipUntilMs: number | null,
  now: number,
): boolean {
  if (skipUntilMs !== null && now < skipUntilMs) return true;
  if (remaining === null) return false;
  return remaining < MIN_RATE_LIMIT_REMAINING;
}

export function skipUntilMsFromResetAt(resetAt: string, now: number): number {
  const reset = Date.parse(resetAt);
  if (!Number.isFinite(reset) || reset <= now) return now + 60 * 60 * 1000;
  return reset;
}

function escapeGraphQlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const PR_WATCH_FRAGMENT = `fragment PrWatchFields on PullRequest {
  id
  url
  number
  title
  updatedAt
  comments(first: 1) { totalCount }
  reviews(first: 1) { totalCount }
  reviewThreads(first: 1) { totalCount }
  latestReviews: reviews(last: 1) {
    nodes { state author { login } }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup { state }
        deployments(last: 3) {
          nodes { createdAt state environment }
        }
      }
    }
  }
}`;

/**
 * One query, one round trip. Aliased `resource(url:)` lookups so the first
 * poll does not need GraphQL node ids. GitHub caps a query's size well above
 * {@link MAX_WATCHED_PRS} of these aliases.
 */
export function buildSnoozedPrWatchQuery(urls: readonly string[]): string {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const canonical = canonicalPullRequestUrl(url);
    if (canonical === null || seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(canonical);
    if (unique.length >= MAX_WATCHED_PRS) break;
  }

  const aliases = unique.map((url, index) => {
    return `  p${index}: resource(url: "${escapeGraphQlString(url)}") { ...PrWatchFields }`;
  });

  return [
    "query GtdSnoozedPrWatch {",
    "  rateLimit { cost remaining resetAt limit }",
    ...aliases,
    "}",
    PR_WATCH_FRAGMENT,
  ].join("\n");
}

export function watchedUrlsForQuery(urls: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const canonical = canonicalPullRequestUrl(url);
    if (canonical === null || seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(canonical);
    if (unique.length >= MAX_WATCHED_PRS) break;
  }
  return unique;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function totalCount(value: unknown): number {
  const record = asRecord(value);
  const count = record === null ? null : asNumber(record.totalCount);
  return count === null || count < 0 ? 0 : count;
}

function parseDeployment(nodes: unknown): PrWatchSnapshot["latestDeployment"] {
  if (!Array.isArray(nodes)) return null;
  let latest: PrWatchSnapshot["latestDeployment"] = null;
  for (const node of nodes) {
    const record = asRecord(node);
    if (record === null) continue;
    const createdAt = asString(record.createdAt);
    const state = asString(record.state);
    if (createdAt === null || state === null) continue;
    const environment = asString(record.environment);
    if (latest === null || createdAt > latest.createdAt) {
      latest = { createdAt, state, environment };
    }
  }
  return latest;
}

export function parsePullRequestNode(value: unknown): PrWatchSnapshot | null {
  const record = asRecord(value);
  if (record === null) return null;
  const nodeId = asString(record.id);
  const url = asString(record.url);
  const number = asNumber(record.number);
  const title = asString(record.title) ?? "";
  const updatedAt = asString(record.updatedAt);
  if (nodeId === null || url === null || number === null || updatedAt === null) {
    return null;
  }
  if (!Number.isInteger(number) || number < 1) return null;

  const latestReviews = asRecord(record.latestReviews);
  const reviewNodes = Array.isArray(latestReviews?.nodes) ? latestReviews.nodes : [];
  const latestReview = asRecord(reviewNodes[0] ?? null);
  const latestReviewAuthor = asRecord(latestReview?.author ?? null);

  const commits = asRecord(record.commits);
  const commitNodes = Array.isArray(commits?.nodes) ? commits.nodes : [];
  const commitWrap = asRecord(commitNodes[0] ?? null);
  const commit = asRecord(commitWrap?.commit ?? null);
  const rollup = asRecord(commit?.statusCheckRollup ?? null);
  const deployments = asRecord(commit?.deployments ?? null);

  return {
    nodeId,
    url,
    number,
    title,
    updatedAt,
    commentCount: totalCount(record.comments),
    reviewCount: totalCount(record.reviews),
    reviewThreadCount: totalCount(record.reviewThreads),
    latestReviewState: asString(latestReview?.state ?? null),
    latestReviewAuthor: asString(latestReviewAuthor?.login ?? null),
    checkRollup: asString(rollup?.state ?? null),
    latestDeployment: parseDeployment(deployments?.nodes ?? null),
  };
}

export function parseRateLimit(value: unknown): PrWatchRateLimit | null {
  const record = asRecord(value);
  if (record === null) return null;
  const cost = asNumber(record.cost);
  const remaining = asNumber(record.remaining);
  const limit = asNumber(record.limit);
  const resetAt = asString(record.resetAt);
  if (cost === null || remaining === null || limit === null || resetAt === null) {
    return null;
  }
  return { cost, remaining, resetAt, limit };
}

export function parseSnoozedPrWatchResponse(raw: unknown): {
  snapshots: PrWatchSnapshot[];
  rateLimit: PrWatchRateLimit | null;
} {
  const root = asRecord(raw);
  const data = asRecord(root?.data ?? root);
  if (data === null) return { snapshots: [], rateLimit: null };

  const snapshots: PrWatchSnapshot[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "rateLimit" || !key.startsWith("p")) continue;
    const snapshot = parsePullRequestNode(value);
    if (snapshot !== null) snapshots.push(snapshot);
  }

  return { snapshots, rateLimit: parseRateLimit(data.rateLimit) };
}

export function isGraphqlRateLimited(raw: unknown, stderr: string): boolean {
  const blob = `${JSON.stringify(raw)} ${stderr}`.toLowerCase();
  return (
    blob.includes("rate limit") ||
    blob.includes("rate_limited") ||
    blob.includes("ratelimited") ||
    blob.includes("secondaryrate") ||
    blob.includes("you have exceeded a secondary rate limit")
  );
}

export function parseStoredSnapshot(raw: string | null): PrWatchSnapshot | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const nodeId = asString(record.nodeId);
  const url = asString(record.url);
  const number = asNumber(record.number);
  const title = asString(record.title) ?? "";
  const updatedAt = asString(record.updatedAt);
  const commentCount = asNumber(record.commentCount);
  const reviewCount = asNumber(record.reviewCount);
  const reviewThreadCount = asNumber(record.reviewThreadCount);
  if (
    nodeId === null ||
    url === null ||
    number === null ||
    updatedAt === null ||
    commentCount === null ||
    reviewCount === null ||
    reviewThreadCount === null
  ) {
    return null;
  }
  if (!Number.isInteger(number) || number < 1) return null;

  const latestDeploymentRecord = asRecord(record.latestDeployment);
  const latestDeployment =
    latestDeploymentRecord === null
      ? null
      : (() => {
          const createdAt = asString(latestDeploymentRecord.createdAt);
          const state = asString(latestDeploymentRecord.state);
          if (createdAt === null || state === null) return null;
          return {
            createdAt,
            state,
            environment: asString(latestDeploymentRecord.environment),
          };
        })();

  return {
    nodeId,
    url,
    number,
    title,
    updatedAt,
    commentCount,
    reviewCount,
    reviewThreadCount,
    latestReviewState: asString(record.latestReviewState),
    latestReviewAuthor: asString(record.latestReviewAuthor),
    checkRollup: asString(record.checkRollup),
    latestDeployment,
  };
}

export function serializeSnapshot(snapshot: PrWatchSnapshot): string {
  return JSON.stringify(snapshot);
}
