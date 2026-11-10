/**
 * The Changes nav's sources, each read on its own while watched: one inbox
 * per forge account, and one list per host from the placement table, never
 * a host listing. Hosts are read three at a time.
 */
import { Effect, Semaphore } from "effect";
import type { Placement } from "../core/change.ts";
import { accountTag, PAGE_SOURCES_TAG } from "../core/ids.ts";
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
/** Hosts read at once while the page is open. */
export const HOST_CONCURRENCY = 3;

/** Every branch of a checkout as rows, from its last read and the stored pull requests. */
export function rowsOf(store: Store, placement: Placement): ChangeRow[] {
  const workspace = store.local(placement.hostId, placement.path).read?.value;
  if (!workspace) return [];
  return workspaceRows({
    hostId: placement.hostId,
    workspace,
    forgeOf: (key) => store.forge(key).read?.value ?? undefined,
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
      rows: checkouts.flatMap((placement) => rowsOf(store, placement)),
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
    hostChanges(keys: readonly string[]): Record<string, SourceRows> {
      return Object.fromEntries(keys.map((hostId) => [hostId, hostRows(store, hostId)]));
    },
    watchHost,
    /** The pull request row any asked-for inbox holds for the Change. */
    inboxRow(key: string): ChangeRow | null {
      for (const login of logins)
        for (const row of store.inbox(login).read?.rows ?? []) if (row.key === key) return row;
      return null;
    },
  };
}

export type ReviewSources = ReturnType<typeof createReviewSources>;
