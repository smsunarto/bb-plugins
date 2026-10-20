import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import type { UnityDiff } from "@bb-plugins/unity-inspector/model";
import { CHANGED_CHANNEL, type LatestTurn } from "../../shared/contract.ts";
import { turnChanges } from "../../shared/patches.ts";
import { readLatestTurn } from "./read-latest-turn.ts";
import { onHostReply, snapshotPatches } from "./snapshots.ts";
import { loadUnityContext } from "./unity-context.ts";
import {
  loadWorkspaceContext,
  workspaceAttributor,
  type WorkspaceContext,
} from "./workspace-attribution.ts";

/** One bounded owner for completed results and their lazy Unity context. */
const MAX_THREADS = 64;
/** Results a client may still display, so their Unity context needs no re-read. */
const MAX_REVISIONS = 64;
/** A degraded thread is retried on a host reply at most this often. */
const RECOVERY_SPACING_MS = 30_000;

const stores = new WeakMap<BbPluginApi, ReturnType<typeof createStore>>();
export function latestTurnStore(bb: BbPluginApi) {
  let store = stores.get(bb);
  if (!store) stores.set(bb, (store = createStore(bb)));
  return store;
}

/** Insert or refresh `key` as most recently used, evicting the least recently used. */
function touch<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

/**
 * What attribution reads from the workspace, without churny fields such as
 * branch names or timestamps, so unrelated environment updates keep the memo.
 */
function workspaceKey(workspace: WorkspaceContext | null) {
  if (!workspace) return null;
  const { environment: e, projects } = workspace;
  const roots = projects.flatMap((p) => p.sources.map((s) => [p.name, s.hostId, s.path]));
  return [
    e && [e.id, e.hostId, e.path, e.name],
    createHash("sha256").update(JSON.stringify(roots)).digest("hex"),
  ];
}

type Environment = WorkspaceContext["environment"];

/**
 * A turn's identity for lazy context reads: its content and the checkout it
 * reads from. Lifecycle events that leave the displayed turn unchanged keep it.
 */
function revisionOf(threadId: string, environment: Environment, turn: LatestTurn): string {
  const identity = [threadId, environment?.hostId ?? null, environment?.path ?? null, turn];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function createStore(bb: BbPluginApi) {
  type Entry = { key: string; result: Promise<LatestTurn | null> };
  type Revision = {
    threadId: string;
    turn: LatestTurn;
    environment: Environment;
    unity: Map<string, Promise<UnityDiff | null>>;
  };
  const entries = new Map<string, Entry>();
  const revisions = new Map<string, Revision>();
  const versions = new Map<string, number>();
  /** Threads whose last read fell back on a failed host scan or workspace lookup. */
  const degraded = new Map<string, { hostId: string | null; retryAt: number }>();
  const invalidate = (threadId: string) => {
    versions.set(threadId, (versions.get(threadId) ?? 0) + 1);
    entries.delete(threadId);
  };
  const read = async (threadId: string): Promise<LatestTurn | null> => {
    const version = versions.get(threadId) ?? 0;
    const [timeline, lookup] = await Promise.all([
      bb.sdk.threads.timeline({ threadId, segmentLimit: "2" }),
      loadWorkspaceContext(bb, threadId),
    ]);
    const { workspace } = lookup;
    // Sequence fences late provider evidence and compaction; workspace identity
    // also fences moves/renames. Captures change only through invalidate().
    const key = JSON.stringify([
      version,
      timeline.maxSeq,
      timeline.contextBoundarySeq,
      workspaceKey(workspace),
    ]);
    const old = entries.get(threadId);
    if (old?.key === key) {
      touch(entries, threadId, old, MAX_THREADS);
      return old.result;
    }
    const environment = workspace?.environment ?? null;
    const entry: Entry = { key, result: Promise.resolve(null) };
    entry.result = (async () => {
      // A failed lookup reads without labels or a target; never keep that.
      let reliable = !lookup.degraded;
      let hostFailed = false;
      const target = environment?.path
        ? { hostId: environment.hostId, environmentPath: environment.path }
        : null;
      const selected = await readLatestTurn(
        bb.sdk.threads,
        threadId,
        target
          ? async (candidates) => {
              try {
                return await snapshotPatches(bb, target, threadId, candidates);
              } catch {
                reliable = false;
                hostFailed = true;
                return [];
              }
            }
          : undefined,
        workspaceAttributor(workspace),
        timeline,
      );
      // An offline fallback must be retried on reconciliation, not cached forever.
      if (!selected.reliable || !reliable) {
        if (entries.get(threadId) === entry) entries.delete(threadId);
      }
      // Transient failures are retried for the client; a summary bb cannot
      // rebuild is not, since retrying it would never recover.
      if (hostFailed || lookup.degraded) {
        const mark = { hostId: target?.hostId ?? null, retryAt: Date.now() + RECOVERY_SPACING_MS };
        touch(degraded, threadId, mark, MAX_THREADS);
      } else {
        degraded.delete(threadId);
      }
      if (!selected.turn) return null;
      const revision = revisionOf(threadId, environment, selected.turn);
      const turn = { ...selected.turn, revision };
      const known = revisions.get(revision);
      touch(
        revisions,
        revision,
        { threadId, turn, environment, unity: known?.unity ?? new Map() },
        MAX_REVISIONS,
      );
      return turn;
    })().catch((error) => {
      if (entries.get(threadId) === entry) entries.delete(threadId);
      throw error;
    });
    if ((versions.get(threadId) ?? 0) === version) touch(entries, threadId, entry, MAX_THREADS);
    return entry.result;
  };

  /**
   * Re-read degraded threads, publishing each that recovers so visible clients
   * refetch. One pass at a time; a thread stops being retried once it reads
   * cleanly, or when its read throws (the thread is gone).
   */
  const recoverPass = async (hostId?: string) => {
    // A copy: a read that degrades again re-inserts its thread, which a live
    // iteration would visit forever.
    for (const [threadId, mark] of Array.from(degraded)) {
      if (degraded.get(threadId) !== mark) continue; // Another read already settled it.
      if (hostId !== undefined && (mark.hostId !== hostId || mark.retryAt > Date.now())) continue;
      try {
        await read(threadId);
      } catch {
        degraded.delete(threadId);
        continue;
      }
      try {
        if (!degraded.has(threadId)) bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      } catch {
        // A reloaded plugin's stale context; its replacement starts fresh.
      }
    }
  };
  let recovery: Promise<void> = Promise.resolve();
  const recover = (hostId?: string) => (recovery = recovery.then(() => recoverPass(hostId)));
  onHostReply(bb, (hostId) => {
    const now = Date.now();
    for (const mark of degraded.values()) {
      if (mark.hostId === hostId && mark.retryAt <= now) {
        void recover(hostId);
        return;
      }
    }
  });

  return {
    read,
    invalidate,
    /** Retry every degraded thread now, as the periodic replay does. */
    recover: () => recover(),
    /**
     * Context for one expanded edit of a result this store produced. Unknown
     * revisions wait only for a read already under way, never start one, so
     * expanding a file never scans the host.
     */
    async unity(threadId: string, revision: string, changeId: string) {
      let record = revisions.get(revision);
      if (!record) {
        await entries.get(threadId)?.result.catch(() => null);
        record = revisions.get(revision);
      }
      if (!record || record.threadId !== threadId) return null;
      touch(revisions, revision, record, MAX_REVISIONS);
      const change = turnChanges(record.turn).find((c) => c.id === changeId);
      if (!change) return null;
      let result = record.unity.get(changeId);
      if (!result) {
        const { environment } = record;
        result = loadUnityContext(
          bb,
          environment?.path ? { hostId: environment.hostId, path: environment.path } : null,
          change,
        );
        record.unity.set(changeId, result);
      }
      return result;
    },
  };
}
