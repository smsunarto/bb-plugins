/**
 * The Changes nav's sources, each read on its own while watched: one inbox
 * per forge account, and one list per host from the placement table, never
 * a host listing. Hosts are read three at a time.
 */
import { Effect, Semaphore } from "effect";
import type { Placement } from "../core/change.ts";
import { accountTag, hostTag, PAGE_SOURCES_TAG, threadTag } from "../core/ids.ts";
import {
  inboxRow,
  workspaceRows,
  type ChangeRow,
  type PageSources,
  type SourceRows,
} from "../core/review.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { LocalReads } from "./local-read.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

/** An inbox is read once a minute while watched: the list's budget is 2.5 calls a minute. */
export const INBOX_MS = 60_000;
/** After GitHub refused an inbox read. */
export const INBOX_BACKOFF_MS = 5 * 60_000;
/** A watched host's checkouts are read again this often; its signals cover the time between. */
export const HOST_LIST_MS = 60_000;
/** How often the hosts with stored checkouts are checked against bb's machines. */
export const HOST_PRUNE_MS = 5 * 60_000;
/** Hosts read at once while the page is open. */
export const HOST_CONCURRENCY = 3;

/**
 * Every branch of a checkout as rows, from its last read and the stored pull
 * requests; `listed` keeps only branches with work, as the nav shows them.
 */
export function rowsOf(store: Store, placement: Placement, listed = false): ChangeRow[] {
  const workspace = store.local(placement.hostId, placement.path).read?.value;
  if (!workspace) return [];
  return workspaceRows({
    hostId: placement.hostId,
    workspace,
    forgeOf: (key) => store.forge(key).read?.value ?? undefined,
    listed,
  });
}

export const checkoutsOn = (store: Store, hostId: string) =>
  store.checkouts().filter((placement) => placement.hostId === hostId);

/** A host's list from its checkouts' last reads: no read yet is pending; a failed read keeps its rows. */
function hostRows(store: Store, hostId: string): SourceRows {
  const checkouts = checkoutsOn(store, hostId);
  const facets = checkouts.map((placement) => store.local(placement.hostId, placement.path));
  const read = facets.flatMap((facet) => (facet.read ? [facet.read.at] : []));
  const problem = facets.find((facet) => facet.problem !== null)?.problem ?? null;
  if (read.length === 0) return { read: null, problem };
  return {
    read: {
      rows: checkouts.flatMap((placement) => rowsOf(store, placement, true)),
      at: Math.min(...read),
    },
    problem,
  };
}

/** How long to wait before an inbox is due again. */
function inboxWait(rows: SourceRows, now: number): number {
  const interval = rows.problem ? INBOX_BACKOFF_MS : INBOX_MS;
  return rows.read ? Math.max(0, interval - (now - rows.read.at)) : 0;
}

export function createReviewSources(deps: {
  store: Store;
  sites: ForgeSites;
  local: LocalReads;
  share: Share;
  invalidate: (tags: readonly string[]) => void;
  now: () => number;
  /** The ids of every machine bb has, connected or not. */
  knownHosts: Effect.Effect<readonly string[], unknown>;
}) {
  const { store } = deps;
  const hosts = Semaphore.makeUnsafe(HOST_CONCURRENCY);
  /** Accounts whose inbox was asked for, so a header can find a pull request in one. */
  const logins = new Set<string>();

  /** Read one account's inbox now, keeping its last rows on failure. */
  const readInboxNow = (login: string) =>
    deps.share(
      `inbox:${login}`,
      Effect.gen(function* () {
        const answer = yield* deps.sites.inbox(login, store.checkouts()).pipe(Effect.result);
        const next: SourceRows =
          answer._tag === "Success"
            ? { read: { rows: answer.success.map(inboxRow), at: deps.now() }, problem: null }
            : { read: store.inbox(login).read, problem: answer.failure.problem };
        if (store.setInbox(login, next)) deps.invalidate([accountTag(login)]);
      }),
    );

  /** While someone watches the inbox: read it when due, once a minute, or every five after a refusal. */
  const watchInbox = (login: string) =>
    Effect.gen(function* () {
      logins.add(login);
      while (true) {
        if (inboxWait(store.inbox(login), deps.now()) === 0) yield* readInboxNow(login);
        yield* Effect.sleep(Math.max(1_000, inboxWait(store.inbox(login), deps.now())));
      }
    });

  /** Forgets a machine bb removed, so it is no longer listed or asked. */
  const forgetHost = (hostId: string) => {
    const { threads, rows } = store.forgetHost(hostId, deps.now());
    if (rows > 0) deps.invalidate([PAGE_SOURCES_TAG, hostTag(hostId), ...threads.map(threadTag)]);
    return rows;
  };

  let pruneAttemptAt = Number.NEGATIVE_INFINITY;
  /**
   * Forgets every stored host bb no longer lists. A failed call or an empty
   * list says nothing about the machines, so then nothing is forgotten; an
   * offline machine is still listed, so it stays.
   */
  const pruneRemovedHosts = deps.share(
    "prune-hosts",
    Effect.gen(function* () {
      pruneAttemptAt = deps.now();
      const known = yield* deps.knownHosts.pipe(Effect.orElseSucceed(() => []));
      if (known.length === 0) return 0;
      const live = new Set(known);
      let rows = 0;
      for (const hostId of store.hostIds()) if (!live.has(hostId)) rows += forgetHost(hostId);
      if (rows > 0) yield* Effect.logInfo(`Forgot ${rows} stored rows of machines bb removed.`);
      return rows;
    }),
  );

  /** While someone watches a host's list: read its checkouts now, then once a minute, holding one of three permits. */
  const watchHost = (hostId: string) =>
    Effect.gen(function* () {
      while (true) {
        yield* hosts.withPermit(
          Effect.forEach(checkoutsOn(store, hostId), (each) => deps.local.readCheckout(each), {
            discard: true,
          }),
        );
        yield* Effect.sleep(HOST_LIST_MS);
      }
    });

  return {
    /**
     * The hosts the placement table has checkouts on, and the accounts known
     * on the server and those hosts. Hosts not asked lately are asked after
     * answering, three at a time, and the sources read again if one has an account.
     */
    pageSources: () =>
      Effect.gen(function* () {
        const checkouts = store.checkouts();
        const accounts = yield* deps.sites.knownAccounts(checkouts);
        yield* Effect.forkDetach(
          deps.share(
            "probe-hosts",
            deps.sites.probeHosts(checkouts).pipe(
              Effect.tap((found) =>
                Effect.sync(() => {
                  if (found) deps.invalidate([PAGE_SOURCES_TAG]);
                }),
              ),
              Effect.asVoid,
            ),
          ),
        );
        if (deps.now() - pruneAttemptAt >= HOST_PRUNE_MS)
          yield* Effect.forkDetach(pruneRemovedHosts);
        const names = new Map<string, string>();
        for (const each of checkouts) names.set(each.hostId, each.hostName);
        return {
          hosts: [...names].map(([hostId, name]) => ({ hostId, name })),
          accounts: accounts.map(({ login, active }) => ({ login, active })),
        } satisfies PageSources;
      }),
    inbox(keys: readonly string[]): Record<string, SourceRows> {
      for (const login of keys) logins.add(login);
      return Object.fromEntries(keys.map((login) => [login, store.inbox(login)]));
    },
    watchInbox,
    /** The hosts the placement table has checkouts on, without asking any of them. */
    checkoutHosts() {
      const hosts = new Map<
        string,
        { hostId: string; name: string; checkouts: { path: string; repo: string | null }[] }
      >();
      for (const each of store.checkouts()) {
        const host = hosts.get(each.hostId) ?? {
          hostId: each.hostId,
          name: each.hostName,
          checkouts: [],
        };
        hosts.set(each.hostId, host);
        if (host.checkouts.some((checkout) => checkout.path === each.path)) continue;
        const github = store.local(each.hostId, each.path).read?.value.github;
        host.checkouts.push({
          path: each.path,
          repo: github ? `${github.repo.owner}/${github.repo.name}` : null,
        });
      }
      return { hosts: [...hosts.values()] };
    },
    hostChanges(keys: readonly string[]): Record<string, SourceRows> {
      return Object.fromEntries(keys.map((hostId) => [hostId, hostRows(store, hostId)]));
    },
    watchHost,
    forgetHost,
    pruneRemovedHosts,
    /** The pull request row any asked-for inbox holds for the Change. */
    inboxRow(key: string): ChangeRow | null {
      for (const login of logins)
        for (const row of store.inbox(login).read?.rows ?? []) if (row.key === key) return row;
      return null;
    },
  };
}

export type ReviewSources = ReturnType<typeof createReviewSources>;
