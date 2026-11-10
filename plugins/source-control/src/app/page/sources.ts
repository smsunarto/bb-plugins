/**
 * The Changes nav's sources: each forge account's inbox and each host's
 * checkouts, as independent keyed reads. Hosts come only from
 * `pageSources`, which the server's placement table fills; nothing here lists
 * hosts any other way. A host still being read blocks nothing: its rows are
 * simply absent, and the nav says it is still reading.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Problem } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import {
  mergeChanges,
  type ChangeRow,
  type Filter,
  type NavRow,
  type PageSources,
  type SourceRows,
} from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";

// ── Small stores shared by the sidebar and the page ────────────────────

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ACCOUNT_KEY = "source-control:review-account";

function storedAccount(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACCOUNT_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The account the nav lists, or null for all of them. Kept on this device. */
const accountChoice = store<string | null>(storedAccount());

export function chooseAccount(login: string | null): void {
  accountChoice.set(login);
  try {
    if (login === null) globalThis.localStorage?.removeItem(ACCOUNT_KEY);
    else globalThis.localStorage?.setItem(ACCOUNT_KEY, login);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

export function useAccountChoice(): string | null {
  return useSyncExternalStore(accountChoice.subscribe, accountChoice.get, accountChoice.get);
}

const NO_HOSTS: ReadonlySet<string> = new Set();
/** Hosts the reader stopped waiting for, for this page's life. */
const stoppedHosts = store<ReadonlySet<string>>(NO_HOSTS);

export function stopHost(hostId: string): void {
  stoppedHosts.set(new Set([...stoppedHosts.get(), hostId]));
}

export function resumeHost(hostId: string): void {
  const next = new Set(stoppedHosts.get());
  next.delete(hostId);
  stoppedHosts.set(next);
}

export function useStoppedHosts(): ReadonlySet<string> {
  return useSyncExternalStore(stoppedHosts.subscribe, stoppedHosts.get, stoppedHosts.get);
}

const filterChoice = store<Filter>("all");
export const chooseFilter = (filter: Filter) => filterChoice.set(filter);
export function useFilter(): Filter {
  return useSyncExternalStore(filterChoice.subscribe, filterChoice.get, filterChoice.get);
}

/** Only for tests: every store back to its first value. */
export function resetNavStores(): void {
  accountChoice.set(null);
  stoppedHosts.set(NO_HOSTS);
  filterChoice.set("all");
}

// ── Sources ────────────────────────────────────────────────────────────

export type SourceStatus =
  /** Nothing read yet. */
  | "pending"
  | "ready"
  /** Read once; the latest attempt failed, so its rows are the last read. */
  | "stale"
  /** Never read, and failing. */
  | "failed";

export type SourceState = {
  id: string;
  kind: "host" | "account";
  name: string;
  status: SourceStatus;
  problem: Problem | null;
  at: number | null;
};

const NO_ROWS: readonly ChangeRow[] = Object.freeze([]);

function statusOf(source: SourceRows | undefined): SourceStatus {
  if (!source || (!source.read && !source.problem)) return "pending";
  if (!source.read) return "failed";
  return source.problem ? "stale" : "ready";
}

/** The same array as last time when every element is the same: rows keep their identity. */
function useSameArray<T>(next: readonly T[]): readonly T[] {
  const [kept, setKept] = useState(next);
  const same = kept.length === next.length && kept.every((value, index) => value === next[index]);
  if (same) return kept;
  // Derived state from the last render, as React documents it: no effect, no ref.
  setKept(next);
  return next;
}

export type ChangeSources = {
  sources: PageSources | undefined;
  sourcesError: string | null;
  states: readonly SourceState[];
  /** Hosts the reader stopped, still known to the placement table. */
  stopped: readonly { hostId: string; name: string }[];
  rowSets: readonly (readonly ChangeRow[])[];
  refetchHost(hostId: string): void;
  refetchAccount(login: string): void;
};

export function useChangeSources(): ChangeSources {
  const page = useRpcQuery({ contract: sourceControlContract, method: "pageSources", input: {} });
  const choice = useAccountChoice();
  const stopped = useStoppedHosts();
  const accounts = page.data?.accounts;
  const hosts = page.data?.hosts;
  const logins = useMemo(() => {
    const all = (accounts ?? []).map((account) => account.login);
    // A chosen account that is gone falls back to all of them.
    return choice !== null && all.includes(choice) ? [choice] : all;
  }, [accounts, choice]);
  const hostIds = useMemo(
    () => (hosts ?? []).map((host) => host.hostId).filter((id) => !stopped.has(id)),
    [hosts, stopped],
  );
  const inbox = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "inbox",
    keys: logins,
    enabled: logins.length > 0,
  });
  const local = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "hostChanges",
    keys: hostIds,
    enabled: hostIds.length > 0,
  });
  const rowSets = useSameArray([
    ...logins.map((login) => inbox.data?.[login]?.read?.rows ?? NO_ROWS),
    ...hostIds.map((id) => local.data?.[id]?.read?.rows ?? NO_ROWS),
  ]);
  const states = useMemo<SourceState[]>(() => {
    const name = new Map((hosts ?? []).map((host) => [host.hostId, host.name]));
    return [
      ...logins.map((login) => {
        const source = inbox.data?.[login];
        return {
          id: login,
          kind: "account" as const,
          name: login,
          status: statusOf(source),
          problem: source?.problem ?? null,
          at: source?.read?.at ?? null,
        };
      }),
      ...hostIds.map((id) => {
        const source = local.data?.[id];
        return {
          id,
          kind: "host" as const,
          name: name.get(id) ?? id,
          status: statusOf(source),
          problem: source?.problem ?? null,
          at: source?.read?.at ?? null,
        };
      }),
    ];
  }, [logins, hostIds, hosts, inbox.data, local.data]);
  const stoppedList = useMemo(
    () => (hosts ?? []).filter((host) => stopped.has(host.hostId)),
    [hosts, stopped],
  );
  const refetchHosts = useRef(local.refetchKeys);
  const refetchInbox = useRef(inbox.refetchKeys);
  useLayoutEffect(() => {
    refetchHosts.current = local.refetchKeys;
    refetchInbox.current = inbox.refetchKeys;
  });
  const refetch = useMemo(
    () => ({
      refetchHost: (id: string) => void refetchHosts.current([id]),
      refetchAccount: (login: string) => void refetchInbox.current([login]),
    }),
    [],
  );
  return {
    sources: page.data,
    sourcesError: page.data === undefined && page.error ? page.error.message : null,
    states,
    stopped: stoppedList,
    rowSets,
    ...refetch,
  };
}

// ── Rows with a stable identity ────────────────────────────────────────

/**
 * Merging builds new row objects. A row equal to the last merge's keeps its
 * old object, so a memoized row redraws only when what it shows changed.
 */
/** Keeps each row's object while its contents stay the same. */
class RowInterner {
  private rows = new Map<ChangeKey, { json: string; row: NavRow }>();
  private next = new Map<ChangeKey, { json: string; row: NavRow }>();

  begin(): void {
    this.next = new Map();
  }

  stable(row: NavRow): NavRow {
    const seen = this.next.get(row.key);
    if (seen) return seen.row;
    const json = JSON.stringify(row);
    const old = this.rows.get(row.key);
    const entry = old && old.json === json ? old : { json, row };
    this.next.set(row.key, entry);
    return entry.row;
  }

  end(): void {
    // Keep entries a filter hides, so switching back reuses them too.
    for (const [key, entry] of this.rows) if (!this.next.has(key)) this.next.set(key, entry);
    this.rows = this.next;
  }
}

export function useMergedChanges(rowSets: readonly (readonly ChangeRow[])[], filter: Filter) {
  const [interner] = useState(() => new RowInterner());
  return useMemo(() => {
    const merged = mergeChanges(rowSets, filter);
    interner.begin();
    const stable = (row: NavRow) => interner.stable(row);
    const shelves = merged.shelves.map((shelf) => ({
      ...shelf,
      groups: shelf.groups.map((group) =>
        "rows" in group ? { id: group.id, rows: group.rows.map(stable) } : stable(group),
      ),
    }));
    const order = merged.order.map(stable);
    interner.end();
    return { shelves, counts: merged.counts, order };
  }, [rowSets, filter, interner]);
}
