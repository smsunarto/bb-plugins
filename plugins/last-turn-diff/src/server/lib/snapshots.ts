import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  attributionSchema,
  snapshotHostContract,
  type Attribution,
  type Pin,
  type SnapshotPatch,
  type TurnWindow,
} from "../../shared/host-contract.ts";
import { z } from "zod";
import type { TurnRow } from "./build-latest-turn.ts";
import { isFileChangeRow } from "./workspace-attribution.ts";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
export type Target = { hostId: string; environmentPath: string };
export type { TurnWindow };
/** Attributions kept per thread; only the latest turns are ever displayed. */
const KEEP_ATTRIBUTIONS = 4;

function client(bb: BbPluginApi) {
  return bb.hosts.experimental_client({ contract: snapshotHostContract });
}

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

/**
 * Snapshot the checkout without pinning it. `at` and `finishedAt` bracket the
 * whole host call on the server clock, the one that stamps turn events.
 */
export async function snapshotWorkspace(bb: BbPluginApi, target: Target): Promise<Shot | null> {
  const at = Date.now();
  const { commit } = await client(bb).call(
    "snapshot",
    { environmentPath: target.environmentPath },
    { hostId: target.hostId },
  );
  return commit ? { commit, at, finishedAt: Date.now() } : null;
}

export async function pinWorkspace(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
  captures: Pin[],
): Promise<void> {
  await deliver(bb, {
    hostId: target.hostId,
    at: Math.max(...captures.map((capture) => capture.at)),
    method: "pin",
    input: { environmentPath: target.environmentPath, threadId, captures },
  });
}

export async function forgetWorkspace(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
): Promise<void> {
  // The server's own records go first: they never depend on reaching the host.
  for (const key of await bb.storage.kv.list(attributionPrefix(threadId))) {
    await bb.storage.kv.delete(key);
  }
  const at = Date.now();
  await deliver(bb, {
    hostId: target.hostId,
    at,
    method: "forget",
    input: { environmentPath: target.environmentPath, threadId, at },
  });
}

/**
 * A pin or forget the thread's host has not taken yet. The host is often a
 * laptop that sleeps while the server runs on, and a lost `stop` leaves its
 * thread looking mid-turn to every other thread in the checkout for hours.
 * Replaying one late is safe: its refs are named for its original
 * server-clock times, so it lands where it would have.
 */
type Owed = { hostId: string; at: number } & (
  | { method: "pin"; input: { environmentPath: string; threadId: string; captures: Pin[] } }
  | { method: "forget"; input: { environmentPath: string; threadId: string; at: number } }
);
const OWED_PREFIX = "owed:";
/** A host away this long is likely removed. What it is owed stops retrying. */
const OWED_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Debts kept per host; the oldest go first. The host already reads an `open`
 * with no `end` hours old as a lost capture, not a running turn.
 */
const MAX_OWED = 100;
/** Hosts replayed at once, so one that times out holds up only its own slot. */
const SETTLE_CONCURRENCY = 4;
/**
 * A failed call this slow timed out. bb lists a host whose socket went
 * half-open, like a Mac asleep, as connected, and each call to it waits out
 * the full host-call timeout. A refusal is a ref write failing in milliseconds.
 */
const TIMED_OUT_MS = 5_000;

function send(bb: BbPluginApi, owed: Owed) {
  const options = { hostId: owed.hostId };
  return owed.method === "pin"
    ? client(bb).call("pin", owed.input, options)
    : client(bb).call("forget", owed.input, options);
}

/** Send after whatever the host is still owed, and keep it owed if the host cannot take it. */
async function deliver(bb: BbPluginApi, owed: Owed): Promise<void> {
  try {
    // A host its replay just failed to reach would only time out again.
    if (!(await settle(bb, owed.hostId))) throw new Error(`host ${owed.hostId} is unreachable`);
    await send(bb, owed);
  } catch (error) {
    // Keys sort by time within a host, so replays go oldest first.
    const prefix = `${OWED_PREFIX}${owed.hostId}:`;
    const at = String(owed.at).padStart(15, "0");
    await bb.storage.kv.set(`${prefix}${at}:${owed.input.threadId}:${owed.method}`, owed);
    const keys = (await bb.storage.kv.list(prefix)).sort();
    for (const stale of keys.slice(0, -MAX_OWED)) await bb.storage.kv.delete(stale);
    throw error;
  }
}

/** A host's replay, and whether it has listed the debts yet. */
type Replay = { listed: boolean; reachable: Promise<boolean> };
/**
 * Each host's newest replay. A caller joins it until it lists the debts, then
 * queues the next, which starts once it ends. So replays never overlap, at
 * most one waits, and every caller's replay sees each debt written before it
 * asked.
 */
const replays = new WeakMap<BbPluginApi, Map<string, Replay>>();

/**
 * Replay what a host is owed, oldest first. Runs before every call that reads
 * or writes the host's refs, so no read sees a thread mid-turn whose end is
 * still waiting here. One the host refuses stays for the next try. False when
 * the host cannot be reached, so the caller skips it too.
 */
function settle(bb: BbPluginApi, hostId: string): Promise<boolean> {
  const hosts = replays.get(bb) ?? new Map<string, Replay>();
  replays.set(bb, hosts);
  const last = hosts.get(hostId);
  if (last && !last.listed) return last.reachable;
  const replay: Replay = { listed: false, reachable: Promise.resolve(true) };
  replay.reachable = (last?.reachable ?? Promise.resolve(true))
    .then((reachable) => {
      if (!reachable) return false; // The replay before this one just failed to reach it.
      replay.listed = true;
      return replayOwed(bb, hostId);
    })
    .finally(() => {
      if (hosts.get(hostId) === replay) hosts.delete(hostId);
    });
  hosts.set(hostId, replay);
  return replay.reachable;
}

async function replayOwed(bb: BbPluginApi, hostId: string): Promise<boolean> {
  for (const key of (await bb.storage.kv.list(`${OWED_PREFIX}${hostId}:`)).sort()) {
    const owed = await bb.storage.kv.get<Owed>(key);
    if (owed?.hostId !== hostId) continue;
    if (owed.at >= Date.now() - OWED_MS) {
      const began = Date.now();
      try {
        await send(bb, owed);
      } catch {
        // A host that cannot answer fails the rest the same way, each after its own timeout.
        if (Date.now() - began >= TIMED_OUT_MS) return false;
        const host = await bb.sdk.hosts.get({ hostId }).catch(() => null);
        if (host?.status !== "connected") return false;
        continue; // The host refused this one alone. Still owed.
      }
    }
    await bb.storage.kv.delete(key);
  }
  return true;
}

/** Replay every host's debts, so a checkout no thread touches again still heals. */
export async function settleOwed(bb: BbPluginApi): Promise<void> {
  const owed = await Promise.all(
    (await bb.storage.kv.list(OWED_PREFIX)).map((key) => bb.storage.kv.get<Owed>(key)),
  );
  const hosts = [...new Set(owed.flatMap((entry) => (entry ? [entry.hostId] : [])))];
  const worker = async () => {
    for (let hostId = hosts.shift(); hostId !== undefined; hostId = hosts.shift()) {
      await settle(bb, hostId);
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

/** The diff between the workspace captures bracketing a turn, when both exist. */
export async function snapshotPatch(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
  window: TurnWindow,
  rows: TurnRow[],
): Promise<SnapshotPatch | null> {
  const key = attributionKey(threadId, window);
  const known = storedAttribution.safeParse(await bb.storage.kv.get(key)).data;
  if (!(await settle(bb, target.hostId))) throw new Error(`host ${target.hostId} is unreachable`);
  const { snapshot } = await client(bb).call(
    "turnPatch",
    {
      environmentPath: target.environmentPath,
      threadId,
      window,
      recordedPaths: recordedPaths(rows),
      ...(known ? { known } : {}),
    },
    { hostId: target.hostId },
  );
  // Ownership can grow on later reads, so compare the whole answer. A turn
  // with nothing to show is skipped, so it never evicts the card on screen.
  const fresh =
    snapshot &&
    (snapshot.patch !== "" || snapshot.attribution.contested.length > 0) &&
    JSON.stringify(known) !== JSON.stringify(snapshot.attribution);
  if (fresh) await remember(bb, threadId, key, snapshot.attribution);
  return snapshot;
}
