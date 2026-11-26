import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { hostContract, hostSignals } from "../host-contract.ts";
import type { SourceStore } from "../source/store.ts";
import {
  conflictPathFor,
  conflictTimestamp,
  deleteSyncFileAndPrune,
  readSyncFile,
  sameDigest,
  sameManifest,
  sanitizeSlug,
  sha256Bytes,
  WRITE_BATCH_BYTES,
  writeJsonAtomic,
  writeSyncFileAtomic,
  type SyncManifest,
} from "./paths.ts";
import { isExcludedSyncPath, planSync } from "./reconcile.ts";

export type HostSyncStatus = {
  hostId: string;
  hostName: string;
  mirrorDir: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
};

type PersistedSyncState = {
  version: 1;
  syncedAt: number;
  files: SyncManifest;
};

type HostClient = ExperimentalHostClient<typeof hostContract, typeof hostSignals>;

const HOST_CALL_TIMEOUT_MS = 30_000;
const PERIODIC_RECONCILE_MS = 5 * 60_000;
const MAX_CAS_RETRIES = 2;
const MAX_DELETE_BATCH = 200;
const MAX_WRITE_BATCH = 200;
const MAX_CONCURRENT_HOSTS = 4;

function isSafeHostId(hostId: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(hostId);
}

/**
 * Coordinates two-way synchronization between the server's `source/` folder and
 * each enrolled non-primary host's `<daemonDataDir>/plugins/agent-instructions/host-data/mirror/` folder.
 *
 * Hosts reconcile independently (bounded to `MAX_CONCURRENT_HOSTS` in parallel)
 * so a slow or offline machine never blocks others.
 */
export function openSyncManager(args: { bb: BbPluginApi; store: SourceStore; host: HostClient }) {
  const { bb, store, host } = args;
  const syncStateDir = join(store.pluginDir, "sync-state");

  let primaryHostId: string | null | undefined;
  let started = false;
  let disposed = false;

  const mirrorDirs = new Map<string, string>();
  const hostNames = new Map<string, string>();
  const hostStatus = new Map<string, HostSyncStatus>();
  const inFlight = new Set<string>();
  const pendingAgain = new Set<string>();
  const pendingWatch = new Set<string>();
  const hostPromises = new Map<string, Promise<void>>();

  // Bounded semaphore across distinct hosts to keep peak memory and I/O bounded.
  let activeSlots = 0;
  const slotWaiters: Array<() => void> = [];
  async function withHostSlot<T>(task: () => Promise<T>): Promise<T> {
    if (activeSlots >= MAX_CONCURRENT_HOSTS) {
      await new Promise<void>((resolve) => slotWaiters.push(resolve));
    }
    activeSlots++;
    try {
      return await task();
    } finally {
      activeSlots--;
      const next = slotWaiters.shift();
      if (next) next();
    }
  }

  function stateFileFor(hostId: string): string {
    if (!isSafeHostId(hostId)) throw new Error(`Invalid host id: ${JSON.stringify(hostId)}`);
    return join(syncStateDir, `${hostId}.json`);
  }

  async function readBase(hostId: string): Promise<SyncManifest> {
    try {
      const parsed = JSON.parse(await readFile(stateFileFor(hostId), "utf8")) as PersistedSyncState;
      if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
        return Object.assign(Object.create(null) as SyncManifest, parsed.files);
      }
    } catch {
      // Cold start: empty base manifest.
    }
    return Object.create(null) as SyncManifest;
  }

  async function writeBase(hostId: string, files: SyncManifest): Promise<void> {
    const payload: PersistedSyncState = { version: 1, syncedAt: Date.now(), files };
    await writeJsonAtomic(stateFileFor(hostId), store.tmpDir, payload, { pretty: true });
  }

  async function removeBase(hostId: string): Promise<void> {
    if (!isSafeHostId(hostId)) return;
    await unlink(stateFileFor(hostId)).catch(() => undefined);
    mirrorDirs.delete(hostId);
    hostNames.delete(hostId);
    hostStatus.delete(hostId);
  }

  async function resolvePrimaryHostId(): Promise<string | null> {
    if (primaryHostId !== undefined) return primaryHostId;
    try {
      const cfg = await bb.sdk.system.config();
      primaryHostId = cfg.primaryHostId ?? null;
      return primaryHostId;
    } catch {
      // Do not permanently cache null on a transient failure; retry on next call.
      return null;
    }
  }

  async function refreshHostNames(): Promise<void> {
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    for (const h of hosts) hostNames.set(h.id, h.name);
  }

  /** Reads `paths` from `hostId` in bounded batches below the 8 MiB RPC output limit. */
  async function fetchHostFiles(
    hostId: string,
    paths: readonly string[],
  ): Promise<Map<string, { bytes: Buffer; executable: boolean; sha256: string }>> {
    const result = new Map<string, { bytes: Buffer; executable: boolean; sha256: string }>();
    let remaining = [...paths];
    while (remaining.length > 0) {
      const batch = remaining.slice(0, MAX_WRITE_BATCH);
      const batchSet = new Set(batch);
      const response = await host.call(
        "mirrorReadFiles",
        { paths: batch },
        { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
      );
      const handled = new Set<string>();
      for (const missingPath of response.missing) {
        if (batchSet.has(missingPath)) handled.add(missingPath);
      }
      for (const file of response.files) {
        if (!batchSet.has(file.path)) continue;
        handled.add(file.path);
        const bytes = Buffer.from(file.base64, "base64");
        if (sha256Bytes(bytes) !== file.sha256) {
          bb.log.warn(`sync(${hostId}): sha256 mismatch on ${file.path}; skipping`);
          continue;
        }
        result.set(file.path, { bytes, executable: file.executable, sha256: file.sha256 });
      }
      const nextRemaining = remaining.filter((p) => !handled.has(p));
      if (nextRemaining.length >= remaining.length) break;
      remaining = nextRemaining;
    }
    return result;
  }

  /**
   * Sends push deletes (chunked <= 200) BEFORE push writes (streamed per batch <= WRITE_BATCH_BYTES)
   * with per-file CAS, requesting a final mirror manifest walk only on the last batch.
   */
  async function pushToHost(
    hostId: string,
    writeSpecs: { path: string; expectedSha256: string | null }[],
    deletes: { path: string; expectedSha256: string }[],
  ): Promise<{ applied: Set<string>; conflicts: Set<string>; manifest: SyncManifest | null }> {
    const applied = new Set<string>();
    const conflicts = new Set<string>();
    let latestManifest: SyncManifest | null = null;

    // 1. Build delete batches (always sent BEFORE writes so file<->dir swaps never hit ENOTDIR/EISDIR).
    const deleteBatches: (typeof deletes)[] = [];
    for (let i = 0; i < deletes.length; i += MAX_DELETE_BATCH) {
      deleteBatches.push(deletes.slice(i, i + MAX_DELETE_BATCH));
    }

    // 2. Read write payloads lazily in bounded batches so we never pin an entire tree in RAM.
    const hasWrites = writeSpecs.length > 0;
    for (let i = 0; i < deleteBatches.length; i++) {
      const isLast = !hasWrites && i === deleteBatches.length - 1;
      const res = await host.call(
        "mirrorApplyOps",
        {
          writes: [],
          deletes: deleteBatches[i]!,
          includeManifest: isLast,
        },
        { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
      );
      for (const p of res.applied) applied.add(p);
      for (const p of res.conflicts) conflicts.add(p);
      if (res.manifest) latestManifest = res.manifest;
    }

    if (hasWrites) {
      let current: {
        path: string;
        executable: boolean;
        base64: string;
        expectedSha256: string | null;
      }[] = [];
      let currentBytes = 0;

      const flushWrites = async (includeManifest: boolean) => {
        if (current.length === 0 && !includeManifest) return;
        const res = await host.call(
          "mirrorApplyOps",
          {
            writes: current,
            deletes: [],
            includeManifest,
          },
          { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
        );
        for (const p of res.applied) applied.add(p);
        for (const p of res.conflicts) conflicts.add(p);
        if (res.manifest) latestManifest = res.manifest;
        current = [];
        currentBytes = 0;
      };

      for (const spec of writeSpecs) {
        const read = await readSyncFile(store.sourceDir, spec.path);
        if (!read) continue;
        if (
          current.length > 0 &&
          (currentBytes + read.bytes.length > WRITE_BATCH_BYTES ||
            current.length >= MAX_WRITE_BATCH)
        ) {
          await flushWrites(false);
        }
        current.push({
          path: spec.path,
          executable: read.executable,
          base64: read.bytes.toString("base64"),
          expectedSha256: spec.expectedSha256,
        });
        currentBytes += read.bytes.length;
      }
      if (current.length > 0 || latestManifest === null) {
        await flushWrites(true);
      }
    }

    return { applied, conflicts, manifest: latestManifest };
  }

  /** Performs one full 3-way reconcile pass with `hostId`. */
  async function reconcileOnce(
    hostId: string,
    ensureWatchFirst: boolean,
    attempt: number,
  ): Promise<void> {
    if (disposed) return;
    if ((await resolvePrimaryHostId()) === hostId) return;

    const snapshot = await host.call(
      ensureWatchFirst ? "mirrorEnsureWatch" : "mirrorSnapshot",
      null,
      { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
    );
    mirrorDirs.set(hostId, snapshot.mirrorDir);
    if (snapshot.symlinks.length > 0)
      bb.log.warn(
        `sync(${hostId}): ignored symlinks in mirror: ${snapshot.symlinks.slice(0, 5).join(", ")}`,
      );
    if (snapshot.tooLarge.length > 0)
      bb.log.warn(
        `sync(${hostId}): ignored oversized files in mirror: ${snapshot.tooLarge.slice(0, 5).join(", ")}`,
      );

    // Abort safely on truncated host walk so omitted files can never be treated as deletes.
    if (snapshot.truncated) {
      throw new Error(
        `Mirror on ${hostId} exceeded the sync file/size budget; refusing partial reconcile to protect source files`,
      );
    }

    // Snapshot server state and base manifest.
    await store.reloadFromDisk("disk");
    const serverWalk = store.lastWalk();
    if (serverWalk.truncated) {
      throw new Error(
        `Server source folder exceeded the sync file/size budget; refusing partial reconcile`,
      );
    }
    const serverBefore = store.manifest();
    const base = await readBase(hostId);
    const hostSlug = sanitizeSlug(hostNames.get(hostId) ?? hostId);
    const ts = conflictTimestamp();

    const excludedHostPaths = [...snapshot.symlinks, ...snapshot.tooLarge];
    const excludedServerPaths = [...serverWalk.symlinks, ...serverWalk.tooLarge];

    const plan = planSync({
      server: serverBefore,
      host: snapshot.manifest,
      base,
      hostSlug,
      timestamp: ts,
      excludedHostPaths,
      excludedServerPaths,
    });

    const pathsToRead = [...plan.pullWrites, ...plan.conflicts.map((c) => c.path)];
    const fetched = pathsToRead.length > 0 ? await fetchHostFiles(hostId, pathsToRead) : new Map();

    // Only acquire the server source lock when there are actual pulls or conflicts to write/delete.
    const extraConflictPushes: string[] = [];
    let serverAfterPull: SyncManifest = serverBefore;

    if (plan.pullDeletes.length > 0 || plan.pullWrites.length > 0 || plan.conflicts.length > 0) {
      let serverMutated = false;
      serverAfterPull = await store.withLock(async () => {
        await store.reloadUnlocked("disk");
        const currentServer = store.manifest();

        // Execute pullDeletes BEFORE pullWrites so file<->directory replacements succeed cleanly.
        for (const path of plan.pullDeletes) {
          if (!sameDigest(currentServer[path], serverBefore[path])) continue;
          if (await deleteSyncFileAndPrune(store.sourceDir, path)) serverMutated = true;
        }

        for (const path of plan.pullWrites) {
          const file = fetched.get(path);
          if (!file) continue;
          // Re-check server did not diverge while we fetched over the network.
          if (!sameDigest(currentServer[path], serverBefore[path])) {
            const dest = conflictPathFor(path, hostSlug, conflictTimestamp());
            await writeSyncFileAtomic(
              store.sourceDir,
              store.tmpDir,
              dest,
              file.bytes,
              file.executable,
            );
            extraConflictPushes.push(dest);
            if (currentServer[path]) {
              plan.pushWrites.push({
                path,
                expectedHostSha256: snapshot.manifest[path]?.sha256 ?? null,
              });
            } else if (snapshot.manifest[path]) {
              plan.pushDeletes.push({ path, expectedHostSha256: snapshot.manifest[path]!.sha256 });
            }
            serverMutated = true;
            bb.log.warn(`sync(${hostId}): conflict on ${path}; saved host copy to ${dest}`);
            continue;
          }
          await writeSyncFileAtomic(
            store.sourceDir,
            store.tmpDir,
            path,
            file.bytes,
            file.executable,
          );
          serverMutated = true;
        }

        for (const conflict of plan.conflicts) {
          const file = fetched.get(conflict.path);
          if (!file) continue;
          await writeSyncFileAtomic(
            store.sourceDir,
            store.tmpDir,
            conflict.conflictPath,
            file.bytes,
            file.executable,
          );
          extraConflictPushes.push(conflict.conflictPath);
          serverMutated = true;
          bb.log.warn(
            `sync(${hostId}): conflict (${conflict.kind}) on ${conflict.path}; saved host copy to ${conflict.conflictPath}`,
          );
        }

        if (serverMutated) {
          await store.reloadUnlocked("sync", hostId);
        }
        return store.manifest();
      });
    }

    // Build push specs (bytes read lazily per batch inside pushToHost).
    const pushWriteSpecs: { path: string; expectedSha256: string | null }[] = [];
    const seenPush = new Set<string>();
    for (const op of plan.pushWrites) {
      seenPush.add(op.path);
      pushWriteSpecs.push({ path: op.path, expectedSha256: op.expectedHostSha256 });
    }
    for (const conflictPath of extraConflictPushes) {
      if (seenPush.has(conflictPath)) continue;
      seenPush.add(conflictPath);
      pushWriteSpecs.push({
        path: conflictPath,
        expectedSha256: snapshot.manifest[conflictPath]?.sha256 ?? null,
      });
    }

    const pushDeleteList = plan.pushDeletes.map((d) => ({
      path: d.path,
      expectedSha256: d.expectedHostSha256,
    }));

    const pushed =
      pushWriteSpecs.length > 0 || pushDeleteList.length > 0
        ? await pushToHost(hostId, pushWriteSpecs, pushDeleteList)
        : { applied: new Set<string>(), conflicts: new Set<string>(), manifest: snapshot.manifest };

    // Compute the new base manifest: only advance paths that actually converged,
    // and never drop excluded (symlink/oversized) entries from base.
    const hostFinal = pushed.manifest ?? snapshot.manifest;
    const nextBase: SyncManifest = Object.create(null) as SyncManifest;
    const allKeys = new Set<string>([
      ...Object.keys(serverAfterPull),
      ...Object.keys(hostFinal),
      ...Object.keys(base),
    ]);
    for (const key of allKeys) {
      if (
        pushed.conflicts.has(key) ||
        isExcludedSyncPath(key, excludedHostPaths) ||
        isExcludedSyncPath(key, excludedServerPaths)
      ) {
        if (Object.hasOwn(base, key)) nextBase[key] = base[key]!;
        continue;
      }
      const s = Object.hasOwn(serverAfterPull, key) ? serverAfterPull[key] : undefined;
      const h = Object.hasOwn(hostFinal, key) ? hostFinal[key] : undefined;
      if (sameDigest(s, h)) {
        if (s) nextBase[key] = s;
      } else if (Object.hasOwn(base, key)) {
        nextBase[key] = base[key]!;
      }
    }
    if (!sameManifest(nextBase, base)) {
      await writeBase(hostId, nextBase);
    }

    // If the host raced with our push (CAS refusal), run one more reconcile to resolve cleanly.
    if (pushed.conflicts.size > 0 && attempt < MAX_CAS_RETRIES) {
      await reconcileOnce(hostId, false, attempt + 1);
      return;
    }

    hostStatus.set(hostId, {
      hostId,
      hostName: hostNames.get(hostId) ?? hostId,
      mirrorDir: mirrorDirs.get(hostId) ?? null,
      lastSyncedAt: Date.now(),
      lastError: null,
    });
  }

  /** Serializes reconciles per host: at most 1 active + 1 coalesced rerun, preserving ensureWatchFirst. */
  function syncHost(hostId: string, ensureWatchFirst = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight.has(hostId)) {
      pendingAgain.add(hostId);
      if (ensureWatchFirst) pendingWatch.add(hostId);
      return hostPromises.get(hostId) ?? Promise.resolve();
    }
    inFlight.add(hostId);
    const run = (async () => {
      let needWatch = ensureWatchFirst;
      while (!disposed) {
        pendingAgain.delete(hostId);
        if (pendingWatch.delete(hostId)) needWatch = true;
        try {
          await withHostSlot(() => reconcileOnce(hostId, needWatch, 0));
          needWatch = false;
        } catch (error) {
          if (disposed) break;
          const message = error instanceof Error ? error.message : String(error);
          hostStatus.set(hostId, {
            hostId,
            hostName: hostNames.get(hostId) ?? hostId,
            mirrorDir: mirrorDirs.get(hostId) ?? null,
            lastSyncedAt: hostStatus.get(hostId)?.lastSyncedAt ?? null,
            lastError: message,
          });
          bb.log.warn(`mirror sync for ${hostId} failed: ${message}`);
        }
        if (!pendingAgain.has(hostId) && !pendingWatch.has(hostId)) break;
      }
    })().finally(() => {
      inFlight.delete(hostId);
      hostPromises.delete(hostId);
    });
    hostPromises.set(hostId, run);
    return run;
  }

  async function syncAllConnected(
    options: {
      excludeHostId?: string;
      ensureWatch?: boolean;
    } = {},
  ): Promise<void> {
    if (disposed || !started) return;
    const primary = await resolvePrimaryHostId();
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    for (const h of hosts) {
      hostNames.set(h.id, h.name);
      if (h.id === primary || h.id === options.excludeHostId) continue;
      if (h.status !== "connected" || h.lifecycle.phase !== "active") continue;
      void syncHost(h.id, options.ensureWatch ?? false);
    }
  }

  /** Awaits sync across connected non-primary hosts (or one specific host when `targetHostId` is set). */
  async function syncNowAll(targetHostId?: string): Promise<HostSyncStatus[]> {
    const primary = await resolvePrimaryHostId();
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    const targets = hosts.filter(
      (h) =>
        h.id !== primary &&
        h.status === "connected" &&
        h.lifecycle.phase === "active" &&
        (targetHostId === undefined || h.id === targetHostId),
    );
    for (const h of targets) hostNames.set(h.id, h.name);
    await Promise.all(targets.map((h) => syncHost(h.id, true)));
    return targets.map(
      (h) =>
        hostStatus.get(h.id) ?? {
          hostId: h.id,
          hostName: h.name,
          mirrorDir: mirrorDirs.get(h.id) ?? null,
          lastSyncedAt: null,
          lastError: null,
        },
    );
  }

  /** Resolves the editable instruction folder path on `hostId` (server source or host mirror). */
  async function editablePathForHost(hostId: string | undefined): Promise<{
    hostId: string | null;
    path: string;
    role: "server" | "mirror";
  }> {
    const primary = await resolvePrimaryHostId();
    if (!hostId || hostId === primary) {
      return { hostId: hostId ?? primary, path: store.sourceDir, role: "server" };
    }
    let mirrorDir = mirrorDirs.get(hostId);
    if (!mirrorDir) {
      const info = await host.call("mirrorInfo", null, { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS });
      mirrorDir = info.mirrorDir;
      mirrorDirs.set(hostId, mirrorDir);
    }
    return { hostId, path: mirrorDir, role: "mirror" };
  }

  // Register lifecycle background service (host RPC calls cannot run before the factory finishes).
  bb.background.service("mirror-sync", {
    async start(signal) {
      disposed = false;
      started = true;
      await syncAllConnected({ ensureWatch: true });

      const unsubHosts = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.id && event.changes.includes("host-connected")) {
            void refreshHostNames().then(() => syncHost(event.id!, true));
          }
        },
      });
      const unsubSignals = host.experimental_onSignal("mirrorChanged", ({ hostId }) => {
        void syncHost(hostId, false);
      });
      const unsubExits = host.experimental_onWorkerExit(({ hostId }) => {
        void syncHost(hostId, true);
      });
      const timer = setInterval(() => {
        void syncAllConnected({ ensureWatch: false });
      }, PERIODIC_RECONCILE_MS);
      timer.unref?.();

      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      disposed = true;
      clearInterval(timer);
      unsubHosts();
      unsubSignals();
      unsubExits();
    },
  });

  bb.events.on("experimental_host.deleted", ({ host: deletedHost }) => {
    void removeBase(deletedHost.id);
  });

  return {
    syncHost,
    syncAllConnected,
    syncNowAll,
    editablePathForHost,
    dispose(): void {
      disposed = true;
    },
  };
}

export type SyncManager = ReturnType<typeof openSyncManager>;
