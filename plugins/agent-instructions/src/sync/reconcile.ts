import { conflictPathFor, sameDigest, type SyncManifest } from "./paths.ts";

export type SyncConflict = {
  /** Original relative path that changed on both server and host. */
  path: string;
  /** Where the host's conflicting bytes are preserved on server and mirrors. */
  conflictPath: string;
  kind: "modify-modify" | "server-delete-host-modify";
};

export type PushWrite = {
  path: string;
  /** The host's current sha256 (null when absent), used for CAS on the host. */
  expectedHostSha256: string | null;
};

export type PushDelete = {
  path: string;
  /** The host's current sha256, used for CAS on the host. */
  expectedHostSha256: string;
};

export type SyncPlan = {
  /** Paths to read from host and write to server. */
  pullWrites: string[];
  /** Paths deleted on host to delete from server. */
  pullDeletes: string[];
  /** Paths to write from server to host (includes server winners on conflict). */
  pushWrites: PushWrite[];
  /** Paths deleted on server to delete from host. */
  pushDeletes: PushDelete[];
  /**
   * Conflicts where both server and host diverged: read host's bytes at `path`,
   * write them to `conflictPath` on the server (and then push `conflictPath` back
   * to the host), while keeping the server's state at `path`.
   */
  conflicts: SyncConflict[];
  /** Paths modified on server and deleted on host; server version is restored on host. */
  restoredOnHost: string[];
};

/**
 * Pure 3-way reconciliation between `server` (S), `host` (H), and their last
 * agreed snapshot `base` (B). Never silently loses a concurrent edit: when both
 * sides modified the same path (or server deleted what host modified), the host's
 * bytes are preserved under `conflicts/<hostSlug>-<timestamp>/<path>` while the
 * server's state remains canonical at `<path>`.
 */
export function planSync(args: {
  server: SyncManifest;
  host: SyncManifest;
  base: SyncManifest;
  hostSlug: string;
  timestamp: string;
}): SyncPlan {
  const { server, host, base, hostSlug, timestamp } = args;
  const allPaths = new Set<string>([
    ...Object.keys(server),
    ...Object.keys(host),
    ...Object.keys(base),
  ]);
  const sorted = [...allPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const pullWrites: string[] = [];
  const pullDeletes: string[] = [];
  const pushWrites: PushWrite[] = [];
  const pushDeletes: PushDelete[] = [];
  const conflicts: SyncConflict[] = [];
  const restoredOnHost: string[] = [];

  for (const path of sorted) {
    const s = server[path];
    const h = host[path];
    const b = base[path];

    // 1. Already converged.
    if (sameDigest(s, h)) continue;

    // 2. Only the server changed (host still matches base).
    if (sameDigest(h, b)) {
      if (s !== undefined) pushWrites.push({ path, expectedHostSha256: h?.sha256 ?? null });
      else if (h !== undefined) pushDeletes.push({ path, expectedHostSha256: h.sha256 });
      continue;
    }

    // 3. Only the host changed (server still matches base).
    if (sameDigest(s, b)) {
      if (h !== undefined) pullWrites.push(path);
      else if (s !== undefined) pullDeletes.push(path);
      continue;
    }

    // 4. Both sides changed differently since base.
    if (s !== undefined && h === undefined) {
      // Server modified while host deleted: restore server's modified version on host.
      pushWrites.push({ path, expectedHostSha256: null });
      restoredOnHost.push(path);
      continue;
    }

    // Host has new/modified bytes (`h !== undefined`) that disagree with server (`s`).
    // Preserve host's bytes as a conflict copy and converge `path` to server's state.
    const conflictPath = conflictPathFor(path, hostSlug, timestamp);
    if (s !== undefined) {
      conflicts.push({ path, conflictPath, kind: "modify-modify" });
      pushWrites.push({ path, expectedHostSha256: h!.sha256 });
    } else {
      conflicts.push({ path, conflictPath, kind: "server-delete-host-modify" });
      pushDeletes.push({ path, expectedHostSha256: h!.sha256 });
    }
  }

  return { pullWrites, pullDeletes, pushWrites, pushDeletes, conflicts, restoredOnHost };
}
