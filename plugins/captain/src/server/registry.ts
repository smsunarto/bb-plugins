import { join } from "node:path";
import type { Role } from "./roles.ts";
import type { CaptainRow, Repo, Store } from "./store.ts";

export type Captain = Omit<CaptainRow, "archivedAt">;

const THREAD_ID = /^thr_[A-Za-z0-9_-]+$/;

/**
 * The live Captains in memory, so `configure` answers "is this thread's parent
 * a Captain?" with one Map lookup. Every write goes to `data.db` first, then
 * here; the map is rebuilt from `data.db` at startup.
 *
 * It also holds what lives only in memory: the server machine's thread-storage
 * root (async to read, so cached for the synchronous `configure`) and the
 * pending roles `dispatch` records before Tasks returns a thread id.
 */
export type Registry = ReturnType<typeof createRegistry>;

export function createRegistry(store: Store) {
  const captains = new Map<string, Captain>(
    store.liveCaptains().map((row) => [row.threadId, withoutArchived(row)]),
  );
  /** Captain id → task key → role, and the Captain's children before that dispatch. */
  const pending = new Map<string, Map<string, { role: Role; known: ReadonlySet<string> }>>();
  let storageRoot: string | null = null;
  /**
   * Each scanned Drive's signature as of its last refresh to every watcher:
   * the scan's own or a CLI write's. Present only while a scan runs.
   */
  const driveBaselines = new Map<string, string>();

  return {
    get(threadId: string | null): Captain | null {
      return threadId === null ? null : (captains.get(threadId) ?? null);
    },
    byName(name: string): Captain | null {
      const wanted = name.trim().toLowerCase();
      for (const captain of captains.values()) {
        if (captain.name.toLowerCase() === wanted) return captain;
      }
      return null;
    },
    put(captain: Captain): void {
      store.putCaptain(captain);
      captains.set(captain.threadId, captain);
    },
    setRepos(captainId: string, repos: Repo[]): void {
      const captain = captains.get(captainId);
      if (captain !== undefined) captains.set(captainId, { ...captain, repos });
    },
    archive(captainId: string, at: number): void {
      store.archiveCaptain(captainId, at);
      captains.delete(captainId);
      pending.delete(captainId);
    },

    /** The Captain's Drive, its thread storage on the server's machine; null until the root is known. */
    driveDir(captainId: string): string | null {
      if (storageRoot === null || !THREAD_ID.test(captainId)) return null;
      return join(storageRoot, captainId);
    },
    storageRoot: () => storageRoot,
    /** What a running Drive scan compares against; undefined when none runs. */
    driveBaseline: (captainId: string) => driveBaselines.get(captainId),
    setDriveBaseline(captainId: string, signature: string | null): void {
      if (signature === null) driveBaselines.delete(captainId);
      else driveBaselines.set(captainId, signature);
    },
    setStorageRoot(root: string | null): void {
      storageRoot = root;
    },

    setPending(
      captainId: string,
      taskKey: string,
      role: Role,
      known: ReadonlySet<string> = new Set(),
    ): void {
      const roles = pending.get(captainId) ?? new Map();
      roles.set(taskKey.toUpperCase(), { role, known });
      pending.set(captainId, roles);
    },
    clearPending(captainId: string, taskKey: string): void {
      const roles = pending.get(captainId);
      roles?.delete(taskKey.toUpperCase());
      if (roles?.size === 0) pending.delete(captainId);
    },
    /**
     * The role an unknown child of this Captain gets: the pending role when
     * every pending entry names the same one, otherwise none, because
     * `configure` cannot tell which child is which. A child that existed
     * before a pending dispatch started, such as a crew thread of a retired
     * role, is not that dispatch's thread and gets none.
     */
    pendingRole(captainId: string, threadId: string): Role | null {
      const entries = [...(pending.get(captainId)?.values() ?? [])];
      if (entries.some((entry) => entry.known.has(threadId))) return null;
      const roles = new Set(entries.map((entry) => entry.role));
      const [only] = roles;
      return roles.size === 1 && only !== undefined ? only : null;
    },
  };
}

function withoutArchived({ archivedAt: _archived, ...captain }: CaptainRow): Captain {
  return captain;
}
