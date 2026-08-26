import { parsePrRefFromTitle, type GithubRepo } from "./github-repo.ts";
import {
  isCacheFresh,
  matchPullForBranch,
  MAX_CLOSED_HEAD_LOOKUPS_PER_TICK,
  MAX_PR_LOOKUPS_PER_TICK,
  MAX_REPOS_PER_TICK,
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
  title: string;
}

export interface PrIndexDeps {
  now: number;
  restRemaining: number | null;
  getCache(environmentId: string): CachedPullRow | undefined;
  putCache(row: CachedPullRow): void;
  getRepo(environmentId: string): Promise<GithubRepo | null>;
  listOpenPulls(repo: GithubRepo): Promise<RestPull[]>;
  getPull(repo: GithubRepo, number: number): Promise<RestPull | null>;
  listClosedPullsByHead(repo: GithubRepo, branchName: string): Promise<RestPull[]>;
  log: { info(message: string): void; warn(message: string): void };
}

function cacheableChoice(chosen: SidebarPullRequest | null): boolean {
  return chosen === null || chosen.source === "rest";
}

function numberedHint(
  query: ThreadPrQuery,
  repo: GithubRepo | null,
  stale: CachedPullRow | undefined,
): { number: number; repo: GithubRepo } | null {
  const fromTitle = parsePrRefFromTitle(query.title);
  const owner = fromTitle?.owner ?? repo?.owner ?? stale?.owner ?? null;
  const name = fromTitle?.repo ?? repo?.repo ?? stale?.repo ?? null;
  const number = fromTitle?.number ?? stale?.number ?? null;
  if (owner === null || name === null || number === null) return null;
  return { number, repo: { owner, repo: name } };
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
      try {
        const pulls = await deps.listOpenPulls(repo);
        pullsByRepo.set(`${repo.owner}/${repo.repo}`, pulls);
      } catch (error) {
        deps.log.warn(`REST pulls for ${repo.owner}/${repo.repo} failed: ${String(error)}`);
      }
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
  let closedHeadLookups = 0;

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
    const pulls = repo === null ? [] : (pullsByRepo.get(`${repo.owner}/${repo.repo}`) ?? []);
    const matched = matchPullForBranch(pulls, query.branchName);
    const fromRest = matched === null ? null : sidebarPrFromRest(matched);
    const stale = query.environmentId === null ? undefined : deps.getCache(query.environmentId);
    const hint = numberedHint(query, repo, stale);

    let fromLookup: SidebarPullRequest | null = null;
    if (fromRest === null && hint !== null) {
      const pulled = await lookupNumbered(hint.repo, hint.number);
      fromLookup = pulled === null ? null : sidebarPrFromRest(pulled);
    }

    let fromClosedHead: SidebarPullRequest | null = null;
    if (
      fromRest === null &&
      fromLookup === null &&
      repo !== null &&
      query.branchName !== null &&
      query.branchName.trim().length > 0 &&
      query.branchName.trim() !== "gitbutler/workspace" &&
      canSpendRest &&
      closedHeadLookups < MAX_CLOSED_HEAD_LOOKUPS_PER_TICK
    ) {
      closedHeadLookups += 1;
      try {
        const closed = await deps.listClosedPullsByHead(repo, query.branchName.trim());
        const closedMatch = matchPullForBranch(closed, query.branchName);
        fromClosedHead = closedMatch === null ? null : sidebarPrFromRest(closedMatch);
      } catch (error) {
        deps.log.warn(
          `REST closed pulls for ${repo.owner}/${repo.repo} ${query.branchName} failed: ${String(error)}`,
        );
      }
    }

    const fromTitle = sidebarPrFromTitle(query.title, hint?.repo ?? repo);
    const fromStale = stale === undefined ? null : sidebarPrFromCache(stale);
    const chosen = fromRest ?? fromLookup ?? fromClosedHead ?? fromStale ?? fromTitle;

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
