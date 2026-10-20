import { hashKey } from "@tanstack/react-query";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { z } from "zod";
import {
  accountSchema,
  prRefSchema,
  statusSchema,
  inboxSchema,
  pullRequestSchema,
  changedFilesSchema,
  checksSchema,
  sameAccount,
  sameRef,
} from "../shared/schema.ts";

const PREFIX = "code-review:snapshot:v1:";
const MAX_AGE = 7 * 24 * 60 * 60_000;
// UTF-16 localStorage quotas vary. Leave room for forms and other plugins.
const MAX_CHARS = 1_500_000;
const MAX_RECORDS = 32;
const input = z.strictObject({ account: accountSchema, ref: prRefSchema });
const common = { updatedAt: z.number().finite().positive() };
const snapshotSchema = z.discriminatedUnion("method", [
  z.object({ ...common, method: z.literal("status"), data: statusSchema }),
  z.object({ ...common, method: z.literal("inbox"), data: inboxSchema }),
  z.object({ ...common, method: z.literal("pullRequest"), input, data: pullRequestSchema }),
  z.object({ ...common, method: z.literal("changedFiles"), input, data: changedFilesSchema }),
  z.object({ ...common, method: z.literal("checks"), input, data: checksSchema }),
]);
type Snapshot = z.infer<typeof snapshotSchema>;
export const LOCAL_READS = snapshotSchema.options.map((schema) => schema.shape.method.value);
const METHODS = new Set<string>(LOCAL_READS);

function parse(value: unknown): Snapshot | null {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) return null;
  const snapshot = result.data;
  if (snapshot.updatedAt > Date.now() || Date.now() - snapshot.updatedAt > MAX_AGE) return null;
  if (snapshot.method === "status" && !snapshot.data.ok) return null;
  if (
    snapshot.method === "pullRequest" &&
    (!sameAccount(snapshot.input.account, snapshot.data.account) ||
      !sameRef(snapshot.input.ref, snapshot.data.ref))
  )
    return null;
  return snapshot;
}

function keyOf(snapshot: Snapshot): QueryKey {
  return "input" in snapshot ? [snapshot.method, snapshot.input] : [snapshot.method];
}

/** TanStack's own hash: object key order cannot split one query across two records. */
function storageKey(queryKey: QueryKey): string {
  return PREFIX + hashKey(queryKey);
}

/** The inbox and account gate must survive speculative PR-cache eviction. */
function isStartupKey(key: string): boolean {
  return key === storageKey(["status"]) || key === storageKey(["inbox"]);
}

/** The accounts gh has, from a status read; null for any other read, or one that does not say. */
function signedIn(method: unknown, data: unknown): readonly string[] | null {
  if (method !== "status") return null;
  const parsed = statusSchema.safeParse(data);
  if (!parsed.success) return null;
  if (parsed.data.ok) return parsed.data.accounts;
  return parsed.data.reason === "unauthenticated" ? [] : null;
}

/** The accounts a read was made as: its input's, or every account a merged read lists. */
function readAs(method: unknown, input: unknown, data: unknown): string[] {
  const named =
    method === "status" || method === "inbox"
      ? (data as { accounts?: unknown } | undefined)?.accounts
      : [(input as { account?: unknown } | undefined)?.account];
  return Array.isArray(named)
    ? named.filter((account): account is string => typeof account === "string")
    : [];
}

/** Whether a read was made as an account outside `accounts`. */
function readAsSignedOut(
  accounts: readonly string[],
  method: unknown,
  input: unknown,
  data: unknown,
): boolean {
  return readAs(method, input, data).some(
    (account) => !accounts.some((each) => sameAccount(each, account)),
  );
}

/** Puts a snapshot in memory unless memory already holds a newer read; `stale` refetches it on next use. */
function adopt(client: QueryClient, snapshot: Snapshot, { stale }: { stale: boolean }): void {
  const queryKey = keyOf(snapshot);
  if ((client.getQueryState(queryKey)?.dataUpdatedAt ?? 0) >= snapshot.updatedAt) return;
  client.setQueryData(queryKey, snapshot.data, { updatedAt: snapshot.updatedAt });
  if (stale) void client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
}

/**
 * The only persistence boundary for read snapshots. Restore synchronously,
 * before hooks render; all subsequent GitHub reads retain their normal cadence.
 * Pending draft previews never enter this cache. No credentials are stored.
 */
export function installLocalCache(client: QueryClient, storage: Storage): () => void {
  for (const method of METHODS)
    client.setQueryDefaults([method], {
      gcTime: 5 * 60_000,
      refetchOnReconnect: "always",
    });
  const read = (key: string): Snapshot | null => {
    try {
      return parse(JSON.parse(storage.getItem(key) ?? "null"));
    } catch {
      return null;
    }
  };
  const index = new Map<string, { size: number; at: number }>();
  const keys = () =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (key): key is string => key?.startsWith(PREFIX) ?? false,
    );
  try {
    for (const key of keys()) {
      const snapshot = read(key);
      if (!snapshot || storageKey(keyOf(snapshot)) !== key) {
        storage.removeItem(key);
        continue;
      }
      index.set(key, { size: storage.getItem(key)?.length ?? 0, at: snapshot.updatedAt });
      adopt(client, snapshot, { stale: true });
    }
  } catch {
    /* Storage denied: keep the ordinary memory cache. */
  }

  /**
   * The accounts gh has, from the newest status read; null until one says.
   * Every write checks it, so a read that finishes after a sign-out is not kept.
   */
  let accounts = signedIn("status", client.getQueryData(["status"]));

  /**
   * Reads made as an account gh no longer has leave disk, and memory too
   * unless a panel shows them. `[]` means gh has no account at all; null, unknown.
   */
  const forgetSignedOut = (next: readonly string[] | null) => {
    if (!next) return;
    accounts = next;
    const gone = (method: unknown, input: unknown, data: unknown) =>
      readAsSignedOut(next, method, input, data);
    try {
      for (const key of keys()) {
        const snapshot = read(key);
        if (!snapshot || !gone(snapshot.method, keyOf(snapshot)[1], snapshot.data)) continue;
        storage.removeItem(key);
        index.delete(key);
      }
      // Unsent text typed as that account goes with its reads.
      const texts = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
        (key): key is string => key?.startsWith(TEXT_PREFIX) ?? false,
      );
      for (const key of texts) {
        const account = textAccount(key);
        if (account && !next.some((each) => sameAccount(each, account))) storage.removeItem(key);
      }
    } catch {
      /* Storage denied: nothing was kept. */
    }
    for (const query of client.getQueryCache().getAll()) {
      const [method, input] = query.queryKey;
      if (!METHODS.has(String(method)) || query.getObserversCount() > 0) continue;
      if (gone(method, input, query.state.data)) client.getQueryCache().remove(query);
    }
  };

  /** Drops the oldest records until `size` more fits, the inbox and account gate last. */
  const makeRoom = (key: string, size: number) => {
    const records = [...index]
      .map(([other, record]) => ({ key: other, size: record.size, at: record.at }))
      .filter((record) => record.key !== key)
      .sort((a, b) => Number(isStartupKey(a.key)) - Number(isStartupKey(b.key)) || a.at - b.at);
    let total = records.reduce((sum, record) => sum + record.size, size);
    while (records.length > 0 && (records.length >= MAX_RECORDS || total > MAX_CHARS)) {
      const oldest = records.shift()!;
      storage.removeItem(oldest.key);
      index.delete(oldest.key);
      total -= oldest.size;
    }
  };

  /** Writes one confirmed read. Throws when storage refuses it. */
  const persist = (query: Query) => {
    const key = storageKey(query.queryKey);
    const [method, input] = query.queryKey;
    if (accounts && readAsSignedOut(accounts, method, input, query.state.data)) return;
    const snapshot = parse({
      method,
      input,
      updatedAt: query.state.dataUpdatedAt,
      data: query.state.data,
    });
    if (!snapshot) return;
    const value = JSON.stringify(snapshot);
    if (value.length > MAX_CHARS / 2) {
      // Too large to keep: an older, smaller copy must not keep restoring instead.
      storage.removeItem(key);
      index.delete(key);
      return;
    }
    // Do not replace a newer snapshot written by another window.
    if ((index.get(key)?.at ?? 0) > snapshot.updatedAt) return;
    // Evict before writing, including when another tab filled the cache.
    makeRoom(key, value.length);
    storage.setItem(key, value);
    index.set(key, { size: value.length, at: snapshot.updatedAt });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Set<string>();
  const flush = () => {
    timer = undefined;
    for (const hash of dirty) {
      const query = client.getQueryCache().get(hash);
      // One refused write (quota, private mode) must not drop the rest, or break a review.
      try {
        if (query) persist(query);
      } catch {
        /* Keep the memory copy; the next success tries again. */
      }
    }
    dirty.clear();
  };
  const markDirty = (hash: string) => {
    dirty.add(hash);
    if (!timer) timer = setTimeout(flush, 200);
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    const query = event.query;
    if (!METHODS.has(String(query.queryKey[0]))) return;
    if (event.type === "added" && query.state.data === undefined) {
      // Memory GC is independent from disk retention. A later panel mount
      // reads its snapshot before the observer can start a network request.
      const snapshot = read(storageKey(query.queryKey));
      if (snapshot && storageKey(keyOf(snapshot)) === storageKey(query.queryKey)) {
        query.setData(snapshot.data, { updatedAt: snapshot.updatedAt, manual: true });
        query.invalidate();
      }
    } else if (event.type === "updated" && event.action.type === "success") {
      // Purge before any pending write, so one queued in this batch is not kept.
      forgetSignedOut(signedIn(query.queryKey[0], query.state.data));
      // A hover prefetch nobody has shown stays in memory: it must not evict PRs the reader opened.
      if (!event.action.manual && query.getObserversCount() === 0) return;
      markDirty(query.queryHash);
    } else if (event.type === "observerAdded" && query.state.data !== undefined) {
      // A prefetched read is kept once a panel shows it.
      const kept = index.get(storageKey(query.queryKey))?.at ?? 0;
      if (kept < query.state.dataUpdatedAt) markDirty(query.queryHash);
    }
  });
  const pagehide = () => {
    if (timer) clearTimeout(timer);
    flush();
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea !== storage || !event.key?.startsWith(PREFIX)) return;
    const snapshot = read(event.key);
    if (!snapshot || storageKey(keyOf(snapshot)) !== event.key) {
      index.delete(event.key);
      return;
    }
    index.set(event.key, { size: event.newValue?.length ?? 0, at: snapshot.updatedAt });
    adopt(client, snapshot, { stale: false });
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("storage", storageChanged);
  }
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    flush();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("storage", storageChanged);
    }
  };
}

/** Form text is durable separately: it is never confused with a saved GitHub draft. */
const TEXT_PREFIX = "code-review:text:v1:";

type TextSubject = { account: string; id: string };
/**
 * Every form's text key, read by the form and cleared by the save that sent it.
 * The account is the second segment, so text typed as a signed-out account is forgotten.
 */
export const draftTextKey = {
  new: (pr: TextSubject, path: string) => `new:${pr.account.toLowerCase()}:${pr.id}:${path}`,
  reply: (pr: TextSubject, threadId: string) => `reply:${pr.account.toLowerCase()}:${threadId}`,
  edit: (pr: TextSubject, commentId: string) => `edit:${pr.account.toLowerCase()}:${commentId}`,
  review: (pr: TextSubject) => `review:${pr.account.toLowerCase()}:${pr.id}`,
};

/** The account a text key was typed as. */
function textAccount(storageKey: string): string | undefined {
  return storageKey.slice(TEXT_PREFIX.length).split(":")[1];
}

/**
 * Text storage refused (quota, private mode), kept for this window until a
 * later write lands. It wins over storage, which still holds an older value.
 */
const unsaved = new Map<string, string>();

/** A form's kept text; `initial` when nothing is kept. An empty string is kept, not missing. */
export function readDraftText(key: string, initial = ""): string {
  const pending = unsaved.get(key);
  if (pending !== undefined) return pending;
  try {
    return window.localStorage.getItem(TEXT_PREFIX + key) ?? initial;
  } catch {
    return initial;
  }
}

/** Keeps `text`, or forgets the entry when it is the form's `initial` text again. */
export function writeDraftText(key: string, text: string, initial = ""): void {
  try {
    if (text === initial) window.localStorage.removeItem(TEXT_PREFIX + key);
    else window.localStorage.setItem(TEXT_PREFIX + key, text);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, text);
  }
}

/** An older save must not erase text written into a reopened form meanwhile. */
export function confirmDraftText(key: string, body: string): void {
  if (readDraftText(key).trim() !== body.trim()) return;
  unsaved.delete(key);
  try {
    window.localStorage.removeItem(TEXT_PREFIX + key);
  } catch {
    /* Nothing was kept on disk to forget. */
  }
}
