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
  await client(bb).call(
    "pin",
    { environmentPath: target.environmentPath, threadId, captures },
    { hostId: target.hostId },
  );
}

export async function forgetWorkspace(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
): Promise<void> {
  await client(bb).call(
    "forget",
    { environmentPath: target.environmentPath, threadId, at: Date.now() },
    { hostId: target.hostId },
  );
  for (const key of await bb.storage.kv.list(attributionPrefix(threadId))) {
    await bb.storage.kv.delete(key);
  }
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
