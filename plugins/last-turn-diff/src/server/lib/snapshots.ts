import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import {
  MAX_SCAN_CANDIDATES,
  attributionSchema,
  snapshotHostContract,
  type Attribution,
  type HostOperation,
  type Pin,
  type SnapshotCandidate,
  type SnapshotPatch,
  type TurnWindow,
} from "../../shared/host-contract.ts";
import { z } from "zod";
import { isFileChangeRow, type TurnRow } from "./build-latest-turn.ts";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
export type Target = { hostId: string; environmentPath: string };
export type { TurnWindow };
const KEEP_ATTRIBUTIONS = 4;
const OWED_PREFIX = "owed:";
const OWED_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OWED = 100;
/**
 * A marker the host refused this often, at least a minute apart, can never
 * land: its commit was pruned or its path now holds another repository. Until
 * then it holds back scans of its own checkout. The spacing keeps a burst of
 * transient ref-lock failures from counting as permanent.
 */
const MAX_REFUSALS = 3;
const REFUSAL_SPACING_MS = 60_000;
const SETTLE_CONCURRENCY = 4;

/** The thread's checkout, or null when it has none yet. */
export async function resolveTarget(
  bb: BbPluginApi,
  thread: Pick<Thread, "environmentId">,
): Promise<Target | null> {
  if (!thread.environmentId) return null;
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  return environment.path
    ? { hostId: environment.hostId, environmentPath: environment.path }
    : null;
}

export interface Shot {
  commit: string;
  at: number;
  finishedAt: number;
}
type Owed = { hostId: string; at: number; refusals?: number; refusedAt?: number } & (
  | { method: "pin"; input: { environmentPath: string; threadId: string; captures: Pin[] } }
  | { method: "forget"; input: { environmentPath: string; threadId: string; at: number } }
);
type SyncInput = z.input<typeof snapshotHostContract.sync.input>;
type SyncOutput = z.infer<typeof snapshotHostContract.sync.output>;

/** Pins are durable before the next host call. Replays use the original server times. */
let operationSequence = 0;
async function owe(bb: BbPluginApi, owed: Owed) {
  const prefix = `${OWED_PREFIX}${owed.hostId}:`;
  await bb.storage.kv.set(
    `${prefix}${String(owed.at).padStart(15, "0")}:${String(operationSequence++).padStart(12, "0")}:${randomUUID()}`,
    owed,
  );
  const keys = (await bb.storage.kv.list(prefix)).sort();
  for (const stale of keys.slice(0, -MAX_OWED)) await bb.storage.kv.delete(stale);
}

/**
 * A capture cannot pin its own server-clock return time until it has returned.
 * Journal it here and piggyback it on the next scan or settle, rather than
 * making a second WAN call. A crash or sleeping laptop leaves replayable markers.
 */
export async function pinWorkspace(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
  captures: Pin[],
) {
  await owe(bb, {
    hostId: target.hostId,
    at: Math.max(...captures.map((c) => c.at)),
    method: "pin",
    input: { environmentPath: target.environmentPath, threadId, captures },
  });
}

const retryAfter = new WeakMap<BbPluginApi, Map<string, number>>();
const replyListeners = new WeakMap<BbPluginApi, Set<(hostId: string) => void>>();

/** Whether the host's last call outlasted a transport timeout, so another would too. */
export function hostStalled(bb: BbPluginApi, hostId: string): boolean {
  return (retryAfter.get(bb)?.get(hostId) ?? 0) > Date.now();
}

/** Observe each successful host reply, such as to retry reads that fell back while it was away. */
export function onHostReply(bb: BbPluginApi, listener: (hostId: string) => void) {
  let listeners = replyListeners.get(bb);
  if (!listeners) replyListeners.set(bb, (listeners = new Set()));
  listeners.add(listener);
}

async function callHost(
  bb: BbPluginApi,
  hostId: string,
  input: SyncInput,
  signal?: AbortSignal,
): Promise<SyncOutput> {
  if (hostStalled(bb, hostId)) throw new Error(`host ${hostId} recently timed out`);
  const began = Date.now();
  const result = await bb.hosts
    .experimental_client({ contract: snapshotHostContract })
    .call("sync", input, { hostId, ...(signal ? { signal } : {}) })
    .catch((error) => {
      // A half-open laptop socket may still be listed as connected. Do not
      // wait out another transport timeout for its queued work or fallback scan.
      if (Date.now() - began >= 5_000) {
        let hosts = retryAfter.get(bb);
        if (!hosts) retryAfter.set(bb, (hosts = new Map()));
        hosts.set(hostId, Date.now() + 30_000);
      }
      throw error;
    });
  if (!result.error) {
    for (const listener of replyListeners.get(bb) ?? []) {
      try {
        listener(hostId);
      } catch {
        // An observer never fails the call it observed.
      }
    }
  }
  return result;
}

/** Captures still journaling their pins, per host. A scan waits for them, never the reverse. */
const journaling = new WeakMap<BbPluginApi, Map<string, Set<Promise<unknown>>>>();
function trackJournal(bb: BbPluginApi, hostId: string, work: Promise<unknown>) {
  let hosts = journaling.get(bb);
  if (!hosts) journaling.set(bb, (hosts = new Map()));
  let pending = hosts.get(hostId);
  if (!pending) hosts.set(hostId, (pending = new Set()));
  pending.add(work);
  const untrack = () => {
    pending.delete(work);
    if (pending.size === 0 && hosts.get(hostId) === pending) hosts.delete(hostId);
  };
  work.then(untrack, untrack);
}

/** Count refusals of operations the host answered without applying; drop hopeless ones. */
async function settleReplies(bb: BbPluginApi, sent: string[], applied: readonly string[]) {
  const acknowledged = new Set(applied);
  for (const id of sent) {
    if (acknowledged.has(id)) {
      await bb.storage.kv.delete(id);
      continue;
    }
    const owed = await bb.storage.kv.get<Owed>(id);
    const now = Date.now();
    if (!owed || (owed.refusedAt !== undefined && now - owed.refusedAt < REFUSAL_SPACING_MS))
      continue;
    const refusals = (owed.refusals ?? 0) + 1;
    if (refusals < MAX_REFUSALS) {
      await bb.storage.kv.set(id, { ...owed, refusals, refusedAt: now });
      continue;
    }
    await bb.storage.kv.delete(id);
    bb.log.warn(
      `dropped a workspace ${owed.method} marker for thread ${owed.input.threadId} in ${owed.input.environmentPath} after ${refusals} refusals`,
    );
  }
}

// Serialize a host's journal exchanges, so acknowledgements never race a second replay.
const exchanges = new WeakMap<BbPluginApi, Map<string, Promise<unknown>>>();
async function exchange(bb: BbPluginApi, hostId: string, job: SyncInput["job"]) {
  let hosts = exchanges.get(bb);
  if (!hosts) exchanges.set(bb, (hosts = new Map()));
  const previous = hosts.get(hostId) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      // A lifecycle capture already under way journals its pin before this
      // reads the journal, so a scan sees every capture that preceded it.
      await Promise.allSettled(journaling.get(bb)?.get(hostId) ?? []);
      const operations: HostOperation[] = [];
      for (const key of (await bb.storage.kv.list(`${OWED_PREFIX}${hostId}:`)).sort()) {
        const owed = await bb.storage.kv.get<Owed>(key);
        if (!owed || owed.at < Date.now() - OWED_MS) {
          await bb.storage.kv.delete(key);
          continue;
        }
        operations.push({ id: key, method: owed.method, input: owed.input } as HostOperation);
      }
      if (!operations.length && job.kind === "settle") return { applied: [] };
      const result = await callHost(bb, hostId, { job, operations });
      await settleReplies(
        bb,
        operations.map((o) => o.id),
        result.applied,
      );
      if (result.error) throw new Error(result.error);
      return result;
    });
  hosts.set(hostId, run);
  try {
    return await run;
  } finally {
    if (hosts.get(hostId) === run) hosts.delete(hostId);
  }
}

/**
 * One bare snapshot, stamped by the server, never the host clock. It writes no
 * refs, so it replays nothing and skips the host's journal queue: neither owed
 * markers nor another thread's scan can delay it. The dispatch baseline and
 * both lifecycle captures use it.
 */
export async function snapshotWorkspace(
  bb: BbPluginApi,
  target: Target,
  signal?: AbortSignal,
): Promise<Shot | null> {
  if (hostStalled(bb, target.hostId)) return null;
  const at = Date.now();
  const { commit, error } = await callHost(
    bb,
    target.hostId,
    { operations: [], job: { kind: "capture", environmentPath: target.environmentPath } },
    signal,
  );
  if (error) throw new Error(error);
  return commit ? { commit, at, finishedAt: Date.now() } : null;
}

/**
 * A lifecycle capture, journaled before any later scan on its host reads the
 * journal. A failed snapshot still leaves a marker.
 */
export async function captureWorkspace(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
  kind: "open" | "end",
  baseline?: Shot,
): Promise<void> {
  const work = (async () => {
    let shot: Shot | null = null;
    let failure: { error: unknown } | null = null;
    try {
      shot = await snapshotWorkspace(bb, target);
    } catch (error) {
      failure = { error };
    }
    const finishedAt = Date.now();
    const capture: Pin = shot
      ? { kind, ...shot }
      : { kind: kind === "open" ? "run" : "stop", at: finishedAt, finishedAt, commit: null };
    const starts: Pin[] = baseline
      ? [
          {
            kind: "start",
            at: baseline.at,
            finishedAt: baseline.finishedAt,
            commit: baseline.commit,
          },
        ]
      : [];
    await pinWorkspace(bb, target, threadId, [...starts, capture]);
    return failure;
  })();
  trackJournal(bb, target.hostId, work);
  const failure = await work;
  if (failure) throw failure.error;
}

/** Journal the thread's forget. The next scan or settle on its host delivers it. */
export async function forgetWorkspace(bb: BbPluginApi, target: Target, threadId: string) {
  for (const key of await bb.storage.kv.list(attributionPrefix(threadId)))
    await bb.storage.kv.delete(key);
  const at = Date.now();
  await owe(bb, {
    hostId: target.hostId,
    at,
    method: "forget",
    input: { environmentPath: target.environmentPath, threadId, at },
  });
}

/** Deliver what one host is owed; a no-op when it is owed nothing. */
export async function settleHost(bb: BbPluginApi, hostId: string) {
  await exchange(bb, hostId, { kind: "settle" });
}

/** One exchange per host, so an offline host never causes one timeout per debt. */
export async function settleOwed(bb: BbPluginApi) {
  const records = await Promise.all(
    (await bb.storage.kv.list(OWED_PREFIX)).map((key) => bb.storage.kv.get<Owed>(key)),
  );
  const hosts = [...new Set(records.flatMap((r) => (r ? [r.hostId] : [])))];
  const worker = async () => {
    for (let id = hosts.shift(); id !== undefined; id = hosts.shift()) {
      await settleHost(bb, id).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: SETTLE_CONCURRENCY }, worker));
}

/** Paths this turn's provider recorded editing, as it reported them. */
function recordedPaths(rows: TurnRow[]): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    if (!isFileChangeRow(row)) continue;
    paths.add(row.change.path);
    if (row.change.movePath) paths.add(row.change.movePath);
  }
  return [...paths].slice(0, 1000);
}

function attributionPrefix(threadId: string): string {
  return `attribution:${threadId}:`;
}

/** Keys sort by completion time, so pruning keeps the newest. */
function attributionKey(threadId: string, window: TurnWindow): string {
  return `${attributionPrefix(threadId)}${String(window.completedAt).padStart(15, "0")}`;
}

/**
 * Attribution depends on other threads' captures, which get pruned or
 * forgotten. Keep the first answer for a capture pair, empty or not, so a card
 * never reshuffles later.
 */
async function remember(bb: BbPluginApi, threadId: string, key: string, value: Attribution) {
  if (JSON.stringify(value).length > 200_000) return;
  await bb.storage.kv.set(key, value);
  const keys = (await bb.storage.kv.list(attributionPrefix(threadId))).sort();
  // Re-saving an older card must not evict it again.
  for (const stale of keys.slice(0, -KEEP_ATTRIBUTIONS)) {
    if (stale !== key) await bb.storage.kv.delete(stale);
  }
}

const pair = { start: z.string(), end: z.string() };
/**
 * Stored attributions, including older builds' shapes. Their files are still
 * evidence once the other thread's captures are gone, so they are converted,
 * not dropped. `foreign` was `contested` minus the turn's recorded edits.
 */
const storedAttribution = z.union([
  attributionSchema,
  z.object({ ...pair, contested: z.array(z.string()) }).transform((a) => ({ ...a, owned: [] })),
  z
    .object({ ...pair, foreign: z.array(z.string()) })
    .transform(({ foreign, ...a }) => ({ ...a, contested: foreign, owned: [] })),
]);

/**
 * Up to MAX_SCAN_CANDIDATES windows share one host hop; empty candidates do not
 * add roundtrips. Fewer results than candidates means the scan stopped early.
 */
export async function snapshotPatches(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
  candidates: { window: TurnWindow; rows: TurnRow[]; canWrite: boolean }[],
): Promise<(SnapshotPatch | null)[]> {
  const inputs = await Promise.all(
    candidates.slice(0, MAX_SCAN_CANDIDATES).map(async ({ window, rows, canWrite }) => {
      const known = storedAttribution.safeParse(
        await bb.storage.kv.get(attributionKey(threadId, window)),
      ).data;
      const input: SnapshotCandidate = { window, canWrite, recordedPaths: recordedPaths(rows) };
      if (known) input.known = known;
      return input;
    }),
  );
  const { snapshots = [] } = await exchange(bb, target.hostId, {
    kind: "scan",
    environmentPath: target.environmentPath,
    threadId,
    candidates: inputs,
  });
  for (const [i, snapshot] of snapshots.entries()) {
    const input = inputs[i];
    if (
      input &&
      snapshot &&
      (snapshot.patch !== "" || snapshot.attribution.contested.length > 0) &&
      JSON.stringify(input.known) !== JSON.stringify(snapshot.attribution)
    ) {
      await remember(bb, threadId, attributionKey(threadId, input.window), snapshot.attribution);
    }
  }
  return snapshots;
}
