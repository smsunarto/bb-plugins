import { parsePrRefFromTitle, type GithubRepo } from "./github-repo.ts";
import {
  isCacheFresh,
  matchPullForBranches,
  matchPullForNumber,
  MAX_PR_LOOKUPS_PER_TICK,
  MAX_REPOS_PER_TICK,
  mergeListedPulls,
  MIN_REST_REMAINING,
  sidebarPrFromCache,
  sidebarPrFromRest,
  sidebarPrFromTitle,
  type CachedPullRow,
  type RestPull,
  type SidebarPullRequest,
} from "./pr-index.ts";

export interface ThreadPrQuery {
  threadId: string;
  environmentId: string | null;
  branchName: string | null;
  /** Extra git refs to try (GitButler virtual branch, bb's own branch). */
  branchNames?: readonly string[];
  title: string;
}

export interface PrIndexDeps {
  now: number;
  restRemaining: number | null;
  getCache(environmentId: string): CachedPullRow | undefined;
  putCache(row: CachedPullRow): void;
  getRepo(environmentId: string): Promise<GithubRepo | null>;
  listOpenPulls(repo: GithubRepo): Promise<RestPull[]>;
  listRecentClosedPulls(repo: GithubRepo): Promise<RestPull[]>;
  getPull(repo: GithubRepo, number: number): Promise<RestPull | null>;
  log: { info(message: string): void; warn(message: string): void };
}

function cacheableChoice(chosen: SidebarPullRequest | null): boolean {
  return chosen === null || chosen.source === "rest";
}

function queryBranchNames(query: ThreadPrQuery): string[] {
  const names: string[] = [];
  for (const name of [query.branchName, ...(query.branchNames ?? [])]) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    names.push(trimmed);
  }
  return [...new Set(names)];
}

function numberedHint(
  query: ThreadPrQuery,
  repo: GithubRepo | null,
  stale: CachedPullRow | undefined,
): { number: number; repo: GithubRepo } | null {
  const fromTitle = parsePrRefFromTitle(query.title);
  const owner = repo?.owner ?? stale?.owner ?? fromTitle?.owner ?? null;
  const name = repo?.repo ?? stale?.repo ?? fromTitle?.repo ?? null;
  // Cache number first: titles often cite a parent PR (`outside the #2255 sweep`)
  // while this thread's own PR is already known.
  const number = stale?.number ?? fromTitle?.number ?? null;
  if (owner === null || name === null || number === null) return null;
  return { number, repo: { owner, repo: name } };
}

function matchFromListedPulls(
  pulls: readonly RestPull[],
  query: ThreadPrQuery,
  stale: CachedPullRow | undefined,
): RestPull | null {
  const byBranch = matchPullForBranches(pulls, queryBranchNames(query));
  if (byBranch !== null) return byBranch;
  const byCacheNumber = matchPullForNumber(pulls, stale?.number ?? null);
  if (byCacheNumber !== null) return byCacheNumber;
  if (stale?.number != null) return null;
  const fromTitle = parsePrRefFromTitle(query.title);
  return matchPullForNumber(pulls, fromTitle?.number ?? null);
}

function usableStaleCache(
  stale: CachedPullRow | undefined,
  listedThisTick: boolean,
): SidebarPullRequest | null {
  const pr = stale === undefined ? null : sidebarPrFromCache(stale);
  if (pr === null) return null;
  if (!listedThisTick) return pr;
  if (pr.state === "merged" || pr.state === "closed") return pr;
  // An open/draft row that is not on this tick's open+closed lists is a lie:
  // #2450 stayed grey after merge because the pre-merge cache was reused.
  return null;
}

export async function resolveThreadPullRequests(
  queries: readonly ThreadPrQuery[],
  deps: PrIndexDeps,
): Promise<ReadonlyMap<string, SidebarPullRequest>> {
  const result = new Map<string, SidebarPullRequest>();
  const pending: ThreadPrQuery[] = [];

  for (const query of queries) {
    const fromTitle = sidebarPrFromTitle(query.title, null);
    if (query.environmentId === null) {
      if (fromTitle !== null) pending.push(query);
      continue;
    }
    const cached = deps.getCache(query.environmentId);
    if (cached !== undefined && isCacheFresh(cached, deps.now)) {
      const pr = sidebarPrFromCache(cached);
      if (pr !== null) result.set(query.threadId, pr);
      continue;
    }
    pending.push(query);
  }

  const repoByEnvironment = new Map<string, GithubRepo | null>();
  const uniqueEnvIds = [
    ...new Set(
      pending.map((query) => query.environmentId).filter((id): id is string => id !== null),
    ),
  ];
  await Promise.all(
    uniqueEnvIds.map(async (environmentId) => {
      try {
        repoByEnvironment.set(environmentId, await deps.getRepo(environmentId));
      } catch (error) {
        deps.log.warn(`git remote for ${environmentId} failed: ${String(error)}`);
        repoByEnvironment.set(environmentId, null);
      }
    }),
  );

  const canSpendRest = deps.restRemaining === null || deps.restRemaining >= MIN_REST_REMAINING;
  const pullsByRepo = new Map<string, RestPull[]>();
  if (canSpendRest) {
    const repos: GithubRepo[] = [];
    const seen = new Set<string>();
    for (const environmentId of uniqueEnvIds) {
      const repo = repoByEnvironment.get(environmentId);
      if (repo === null || repo === undefined) continue;
      const key = `${repo.owner}/${repo.repo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(repo);
      if (repos.length >= MAX_REPOS_PER_TICK) break;
    }
    for (const repo of repos) {
      const key = `${repo.owner}/${repo.repo}`;
      let open: RestPull[] = [];
      let closed: RestPull[] = [];
      try {
        open = await deps.listOpenPulls(repo);
      } catch (error) {
        deps.log.warn(`REST open pulls for ${key} failed: ${String(error)}`);
      }
      try {
        closed = await deps.listRecentClosedPulls(repo);
      } catch (error) {
        deps.log.warn(`REST closed pulls for ${key} failed: ${String(error)}`);
      }
      pullsByRepo.set(key, mergeListedPulls(open, closed));
    }
    deps.log.info(
      `pr-index listed ${pullsByRepo.size} repos for ${pending.length} threads (REST remaining ${deps.restRemaining ?? "unknown"})`,
    );
  } else {
    deps.log.info(
      `pr-index skipping REST (${deps.restRemaining} remaining); cache and titles only`,
    );
  }

  const pullByNumber = new Map<string, RestPull | null>();
  let numberedLookups = 0;

  const lookupNumbered = async (
    repo: GithubRepo,
    number: number,
  ): Promise<RestPull | null> => {
    const key = `${repo.owner}/${repo.repo}#${number}`;
    if (pullByNumber.has(key)) return pullByNumber.get(key) ?? null;
    if (!canSpendRest || numberedLookups >= MAX_PR_LOOKUPS_PER_TICK) return null;
    numberedLookups += 1;
    try {
      const pull = await deps.getPull(repo, number);
      pullByNumber.set(key, pull);
      return pull;
    } catch (error) {
      deps.log.warn(`REST pull ${key} failed: ${String(error)}`);
      pullByNumber.set(key, null);
      return null;
    }
  };

  for (const query of pending) {
    const repo =
      query.environmentId === null ? null : (repoByEnvironment.get(query.environmentId) ?? null);
    const repoKey = repo === null ? null : `${repo.owner}/${repo.repo}`;
    const listedThisTick = repoKey !== null && pullsByRepo.has(repoKey);
    const pulls = repoKey === null ? [] : (pullsByRepo.get(repoKey) ?? []);
    const stale = query.environmentId === null ? undefined : deps.getCache(query.environmentId);
    const listed = matchFromListedPulls(pulls, query, stale);
    const fromList = listed === null ? null : sidebarPrFromRest(listed);
    const hint = numberedHint(query, repo, stale);

    let fromLookup: SidebarPullRequest | null = null;
    if (fromList === null && hint !== null) {
      const pulled = await lookupNumbered(hint.repo, hint.number);
      fromLookup = pulled === null ? null : sidebarPrFromRest(pulled);
    }

    const fromTitle = listedThisTick
      ? null
      : sidebarPrFromTitle(query.title, hint?.repo ?? repo);
    const fromStale = usableStaleCache(stale, listedThisTick);
    const chosen = fromList ?? fromLookup ?? fromStale ?? fromTitle;

    if (query.environmentId !== null && cacheableChoice(chosen)) {
      deps.putCache({
        environmentId: query.environmentId,
        owner: repo?.owner ?? hint?.repo.owner ?? stale?.owner ?? null,
        repo: repo?.repo ?? hint?.repo.repo ?? stale?.repo ?? null,
        number: chosen?.number ?? null,
        title: chosen?.title ?? null,
        url: chosen?.url ?? null,
        state: chosen?.state ?? null,
        attention: chosen?.attention ?? null,
        fetchedAt: deps.now,
      });
    }
    if (chosen !== null) result.set(query.threadId, chosen);
  }

  return result;
}
