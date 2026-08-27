/**
 * Sidebar PR badges without per-card `gh pr view`.
 *
 * bb's own hook runs GraphQL once per environment on mount. Reloading the
 * plugin stampedes that path and burns the 5,000-point GraphQL budget, after
 * which every badge goes blank. This path uses REST (`/repos/.../pulls`, a
 * separate 5,000/hour budget), one open list per repository, then a numbered
 * GET when that list misses (merged PRs drop off it), then title-text and a
 * local cache when REST is too tight to spend.
 */

import { githubPullUrl, parsePrRefFromTitle, type GithubRepo } from "./github-repo.ts";

export const PR_CACHE_FRESH_MS = 15 * 60 * 1000;
export const PR_MISS_CACHE_MS = 5 * 60 * 1000;
export const MIN_REST_REMAINING = 80;
export const MAX_REPOS_PER_TICK = 12;
export const MAX_PR_LOOKUPS_PER_TICK = 40;

export interface SidebarPullRequest {
  number: number;
  title: string;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  attention: string;
  source: "rest" | "cache" | "title";
}

export interface RestPull {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  /** GitHub `mergeable_state`, or "unknown" when the list omits it. */
  mergeableState: string;
  autoMerge: boolean;
}

export interface CachedPullRow {
  environmentId: string;
  owner: string | null;
  repo: string | null;
  number: number | null;
  title: string | null;
  url: string | null;
  state: string | null;
  attention: string | null;
  fetchedAt: number;
}

export function isCacheFresh(row: CachedPullRow, now: number): boolean {
  if (row.number === null) return now - row.fetchedAt < PR_MISS_CACHE_MS;
  // Open and draft still move (merge, close). Trusting them for 15 minutes
  // left merged PRs grey until the title fallback recached them as open.
  if (row.state !== "merged" && row.state !== "closed") return false;
  return now - row.fetchedAt < PR_CACHE_FRESH_MS;
}

export function sidebarPrFromCache(row: CachedPullRow): SidebarPullRequest | null {
  if (
    row.number === null ||
    row.title === null ||
    row.url === null ||
    row.state === null ||
    row.attention === null
  ) {
    return null;
  }
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    state: asPrState(row.state),
    attention: row.attention,
    source: "cache",
  };
}

function asPrState(value: string): SidebarPullRequest["state"] {
  if (value === "draft" || value === "merged" || value === "closed") return value;
  return "open";
}

export function parseRestPull(raw: unknown): RestPull | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const number = record.number;
  const title = record.title;
  const url = record.html_url;
  const state = record.state;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  if (typeof title !== "string" || typeof url !== "string") return null;
  if (state !== "open" && state !== "closed") return null;
  const head = record.head;
  const headRef =
    typeof head === "object" && head !== null && !Array.isArray(head)
      ? (head as Record<string, unknown>).ref
      : null;
  return {
    number,
    title,
    url,
    draft: record.draft === true,
    state,
    merged: record.merged === true || (record.merged_at != null && record.merged_at !== ""),
    headRef: typeof headRef === "string" ? headRef : "",
    mergeableState: typeof record.mergeable_state === "string" ? record.mergeable_state : "unknown",
    autoMerge: record.auto_merge != null,
  };
}

export function parseRestPulls(raw: unknown): RestPull[] {
  if (!Array.isArray(raw)) return [];
  const pulls: RestPull[] = [];
  for (const entry of raw) {
    const parsed = parseRestPull(entry);
    if (parsed !== null) pulls.push(parsed);
  }
  return pulls;
}

export function matchPullForBranch(
  pulls: readonly RestPull[],
  branchName: string | null,
): RestPull | null {
  if (branchName === null || branchName.trim().length === 0) return null;
  const wanted = branchName.trim();
  if (wanted === "gitbutler/workspace") return null;
  if (/^\d+ GitButler branches$/u.test(wanted)) return null;
  const matches = pulls.filter((pull) => pull.headRef === wanted);
  if (matches.length === 0) return null;
  const open = matches.find((pull) => pull.state === "open");
  return open ?? matches[0] ?? null;
}

export function matchPullForBranches(
  pulls: readonly RestPull[],
  branchNames: readonly string[],
): RestPull | null {
  for (const branchName of branchNames) {
    const matched = matchPullForBranch(pulls, branchName);
    if (matched !== null) return matched;
  }
  return null;
}

export function matchPullForNumber(
  pulls: readonly RestPull[],
  number: number | null | undefined,
): RestPull | null {
  if (number === null || number === undefined) return null;
  return pulls.find((pull) => pull.number === number) ?? null;
}

/** Closed first, then open, so an open PR with the same number wins. */
export function mergeListedPulls(
  open: readonly RestPull[],
  closed: readonly RestPull[],
): RestPull[] {
  const byNumber = new Map<number, RestPull>();
  for (const pull of closed) byNumber.set(pull.number, pull);
  for (const pull of open) byNumber.set(pull.number, pull);
  return [...byNumber.values()];
}

export function restPullAttention(pull: RestPull): string {
  if (pull.merged) return "merged";
  if (pull.state === "closed") return "closed";
  if (pull.draft || pull.mergeableState === "draft") return "draft";
  if (pull.autoMerge) return "queued";
  switch (pull.mergeableState) {
    case "dirty":
      return "conflicts";
    case "unstable":
      return "checks_failed";
    case "blocked":
      return "blocked";
    case "clean":
      return "ready_to_merge";
    default:
      return "none";
  }
}

export function sidebarPrFromRest(pull: RestPull): SidebarPullRequest {
  const state: SidebarPullRequest["state"] = pull.merged
    ? "merged"
    : pull.draft
      ? "draft"
      : pull.state === "closed"
        ? "closed"
        : "open";
  return {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    state,
    attention: restPullAttention(pull),
    source: "rest",
  };
}

export function sidebarPrFromTitle(
  title: string,
  repo: GithubRepo | null,
): SidebarPullRequest | null {
  const ref = parsePrRefFromTitle(title);
  if (ref === null) return null;
  const owner = ref.owner ?? repo?.owner ?? null;
  const name = ref.repo ?? repo?.repo ?? null;
  if (owner === null || name === null) return null;
  const state = "open";
  return {
    number: ref.number,
    title,
    url: githubPullUrl(owner, name, ref.number),
    state,
    attention: "none",
    source: "title",
  };
}

export function parseRestRateLimit(raw: unknown): {
  restRemaining: number;
  graphqlRemaining: number;
} | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const resources = (raw as Record<string, unknown>).resources;
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
    return null;
  }
  const core = (resources as Record<string, unknown>).core;
  const graphql = (resources as Record<string, unknown>).graphql;
  const restRemaining =
    typeof core === "object" && core !== null ? (core as Record<string, unknown>).remaining : null;
  const graphqlRemaining =
    typeof graphql === "object" && graphql !== null
      ? (graphql as Record<string, unknown>).remaining
      : null;
  if (typeof restRemaining !== "number" || typeof graphqlRemaining !== "number") return null;
  return { restRemaining, graphqlRemaining };
}

/**
 * True when only a numbered GET can decide this pull's attention.
 *
 * `/repos/.../pulls` omits `mergeable_state` — GitHub computes it lazily and
 * serves it from the single-PR route alone. Everything read off the list
 * therefore arrived as "unknown", collapsed to attention "none", and painted
 * green: #377 showed as a healthy open PR while it was blocked with failing
 * checks. Draft, merged, closed and auto-merge are all decidable from the list
 * itself, so they never spend the extra call.
 */
export function needsMergeStateLookup(pull: RestPull): boolean {
  if (pull.merged || pull.state === "closed") return false;
  if (pull.draft || pull.autoMerge) return false;
  return pull.mergeableState === "unknown";
}
