import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { hostContract, hostSignals } from "../host-contract.ts";
import type { SourceStore } from "../source/store.ts";
import {
  conflictPathFor,
  conflictTimestamp,
  deleteSyncFileAndPrune,
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_FILES,
  MAX_SYNC_TOTAL_BYTES,
  readSyncFile,
  sameDigest,
  sameManifest,
  sanitizeSlug,
  sha256Bytes,
  throwIfAborted,
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
const WORKER_EXIT_BASE_DELAY_MS = 1_000;
const WORKER_EXIT_MAX_DELAY_MS = 60_000;
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
export function openSyncManager(args: {
  bb: BbPluginApi;
  store: SourceStore;
  host: HostClient;
  workerExitBaseDelayMs?: number;
}) {
  const { bb, store, host } = args;
  const workerExitBaseDelayMs = args.workerExitBaseDelayMs ?? WORKER_EXIT_BASE_DELAY_MS;
  const syncStateDir = join(store.pluginDir, "sync-state");

  let primaryHostId: string | null | undefined;
  let started = false;
  let disposed = false;
  let serviceSignal: AbortSignal | undefined;

  const mirrorDirs = new Map<string, string>();
  const hostNames = new Map<string, string>();
  const hostStatus = new Map<string, HostSyncStatus>();
  const inFlight = new Set<string>();
  const pendingAgain = new Set<string>();
  const pendingWatch = new Set<string>();
  const hostPromises = new Map<string, Promise<void>>();
  const workerExitAttempts = new Map<string, number>();
  const workerExitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearWorkerExitTimer(hostId: string): void {
    const timer = workerExitTimers.get(hostId);
    if (timer) {
      clearTimeout(timer);
      workerExitTimers.delete(hostId);
    }
  }

  function clearAllWorkerExitTimers(): void {
    for (const timer of workerExitTimers.values()) clearTimeout(timer);
    workerExitTimers.clear();
  }

  function hostCallOptions(hostId: string, signal?: AbortSignal) {
    return {
      hostId,
      timeoutMs: HOST_CALL_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    };
  }

  // Coalesce concurrent server disk reloads and skip them when the source watcher confirms disk is clean.
  let inFlightReload: Promise<void> | null = null;
  async function ensureFreshServerState(force: boolean): Promise<void> {
    if (!force && store.isDiskClean()) return;
    if (!inFlightReload) {
      inFlightReload = store
        .reloadFromDisk("disk")
        .then(() => undefined)
        .finally(() => {
          inFlightReload = null;
        });
    }
    await inFlightReload;
  }

  // Bounded semaphore across distinct hosts to keep peak memory and I/O bounded.
  let activeSlots = 0;
  const slotWaiters: Array<() => void> = [];
  async function withHostSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (activeSlots >= MAX_CONCURRENT_HOSTS) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = slotWaiters.indexOf(wake);
          if (idx >= 0) slotWaiters.splice(idx, 1);
          try {
            throwIfAborted(signal);
          } catch (error) {
            reject(error);
          }
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        slotWaiters.push(wake);
      });
    }
    activeSlots++;
    try {
      throwIfAborted(signal);
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
    workerExitAttempts.delete(hostId);
    clearWorkerExitTimer(hostId);
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

  /**
   * Reads `paths` from `hostId` in bounded batches below the 8 MiB RPC output limit.
   * Enforces per-file `MAX_SYNC_FILE_BYTES`, cumulative `MAX_SYNC_TOTAL_BYTES`, and
   * verifies each file's sha256 against the snapshot manifest so a racing/malicious host
   * cannot exhaust server RAM.
   */
  async function fetchHostFiles(
    hostId: string,
    paths: readonly string[],
    expectedDigests: SyncManifest,
    signal?: AbortSignal,
  ): Promise<Map<string, { bytes: Buffer; executable: boolean; sha256: string }>> {
    const result = new Map<string, { bytes: Buffer; executable: boolean; sha256: string }>();
    let remaining = [...paths];
    let totalFetchedBytes = 0;
    while (remaining.length > 0) {
      throwIfAborted(signal);
      const batch = remaining.slice(0, MAX_WRITE_BATCH);
      const batchSet = new Set(batch);
      const response = await host.call(
        "mirrorReadFiles",
        { paths: batch },
        hostCallOptions(hostId, signal),
      );
      const handled = new Set<string>();
      for (const missingPath of response.missing) {
        if (batchSet.has(missingPath)) handled.add(missingPath);
      }
      for (const file of response.files) {
        if (!batchSet.has(file.path)) continue;
        handled.add(file.path);
        const bytes = Buffer.from(file.base64, "base64");
        if (bytes.length > MAX_SYNC_FILE_BYTES) {
          bb.log.warn(`sync(${hostId}): ${file.path} exceeds MAX_SYNC_FILE_BYTES; skipping`);
          continue;
        }
        if (sha256Bytes(bytes) !== file.sha256) {
          bb.log.warn(`sync(${hostId}): sha256 mismatch on ${file.path}; skipping`);
          continue;
        }
        const expected = Object.hasOwn(expectedDigests, file.path)
          ? expectedDigests[file.path]
          : undefined;
        if (!expected || expected.sha256 !== file.sha256) {
          bb.log.warn(
            `sync(${hostId}): ${file.path} changed since snapshot; skipping until next reconcile`,
          );
          continue;
        }
        totalFetchedBytes += bytes.length;
        if (totalFetchedBytes > MAX_SYNC_TOTAL_BYTES) {
          throw new Error(
            `Mirror pull from ${hostId} exceeded ${MAX_SYNC_TOTAL_BYTES}-byte total sync budget`,
          );
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
    signal?: AbortSignal,
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
      throwIfAborted(signal);
      const isLast = !hasWrites && i === deleteBatches.length - 1;
      const res = await host.call(
        "mirrorApplyOps",
        {
          writes: [],
          deletes: deleteBatches[i]!,
          includeManifest: isLast,
        },
        hostCallOptions(hostId, signal),
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
        throwIfAborted(signal);
        const res = await host.call(
          "mirrorApplyOps",
          {
            writes: current,
            deletes: [],
            includeManifest,
          },
          hostCallOptions(hostId, signal),
        );
        for (const p of res.applied) applied.add(p);
        for (const p of res.conflicts) conflicts.add(p);
        if (res.manifest) latestManifest = res.manifest;
        current = [];
        currentBytes = 0;
      };

      for (const spec of writeSpecs) {
        throwIfAborted(signal);
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
    signal?: AbortSignal,
    skipDiskReload = false,
  ): Promise<void> {
    if (disposed) return;
    throwIfAborted(signal);
    const blocked = store.migrationBlocked();
    if (blocked) {
      throw new Error(`Mirror sync blocked: ${blocked}`);
    }
    if ((await resolvePrimaryHostId()) === hostId) return;

    const snapshot = await host.call(
      ensureWatchFirst ? "mirrorEnsureWatch" : "mirrorSnapshot",
      null,
      hostCallOptions(hostId, signal),
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

    // Snapshot server state and base manifest (skip disk walk when the source watcher confirms disk is clean).
    if (!skipDiskReload) {
      await ensureFreshServerState(false);
    }
    throwIfAborted(signal);
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
    const fetched =
      pathsToRead.length > 0
        ? await fetchHostFiles(hostId, pathsToRead, snapshot.manifest, signal)
        : new Map();

    // Only acquire the server source lock when there are actual pulls or conflicts to write/delete.
    const extraConflictPushes: string[] = [];
    let serverAfterPull: SyncManifest = serverBefore;

    if (plan.pullDeletes.length > 0 || plan.pullWrites.length > 0 || plan.conflicts.length > 0) {
      let serverMutated = false;
      serverAfterPull = await store.withLock(async () => {
        await store.reloadUnlocked("disk");
        const currentServer = store.manifest();

        // Project post-pull file count and total bytes BEFORE mutating sourceDir so merging
        // server + mirror can never push server source/ past MAX_SYNC_FILES or MAX_SYNC_TOTAL_BYTES.
        let projectedCount = 0;
        let projectedBytes = 0;
        for (const key of Object.keys(currentServer)) {
          projectedCount++;
          projectedBytes += currentServer[key]!.size;
        }
        const deletedSet = new Set<string>();
        for (const path of plan.pullDeletes) {
          if (
            Object.hasOwn(currentServer, path) &&
            sameDigest(currentServer[path], serverBefore[path])
          ) {
            projectedCount--;
            projectedBytes -= currentServer[path]!.size;
            deletedSet.add(path);
          }
        }
        for (const path of plan.pullWrites) {
          const file = fetched.get(path);
          if (!file) continue;
          const existsNow = Object.hasOwn(currentServer, path) && !deletedSet.has(path);
          if (!sameDigest(currentServer[path], serverBefore[path])) {
            // Late server race writes a new conflict copy without replacing `path`.
            projectedCount++;
            projectedBytes += file.bytes.length;
          } else if (existsNow) {
            projectedBytes += file.bytes.length - currentServer[path]!.size;
          } else {
            projectedCount++;
            projectedBytes += file.bytes.length;
          }
        }
        for (const conflict of plan.conflicts) {
          const file = fetched.get(conflict.path);
          if (!file) continue;
          projectedCount++;
          projectedBytes += file.bytes.length;
        }
        if (projectedCount > MAX_SYNC_FILES || projectedBytes > MAX_SYNC_TOTAL_BYTES) {
          throw new Error(
            `Pull from ${hostId} would exceed server sync budget (${projectedCount}/${MAX_SYNC_FILES} files, ${projectedBytes}/${MAX_SYNC_TOTAL_BYTES} bytes); aborting without modifying server source/`,
          );
        }

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
        ? await pushToHost(hostId, pushWriteSpecs, pushDeleteList, signal)
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
      await reconcileOnce(hostId, false, attempt + 1, signal, false);
      return;
    }

    workerExitAttempts.delete(hostId);
    clearWorkerExitTimer(hostId);
    hostStatus.set(hostId, {
      hostId,
      hostName: hostNames.get(hostId) ?? hostId,
      mirrorDir: mirrorDirs.get(hostId) ?? null,
      lastSyncedAt: Date.now(),
      lastError: null,
    });
  }

  /** Serializes reconciles per host: at most 1 active + 1 coalesced rerun, preserving ensureWatchFirst. */
  function syncHost(
    hostId: string,
    ensureWatchFirst = false,
    options: { signal?: AbortSignal; skipDiskReload?: boolean } = {},
  ): Promise<void> {
    const effectiveSignal = options.signal ?? serviceSignal;
    if (disposed || effectiveSignal?.aborted) return Promise.resolve();
    if (inFlight.has(hostId)) {
      pendingAgain.add(hostId);
      if (ensureWatchFirst) pendingWatch.add(hostId);
      return hostPromises.get(hostId) ?? Promise.resolve();
    }
    inFlight.add(hostId);
    const run = (async () => {
      let needWatch = ensureWatchFirst;
      let skipDiskReload = options.skipDiskReload ?? false;
      while (!disposed && !effectiveSignal?.aborted) {
        pendingAgain.delete(hostId);
        if (pendingWatch.delete(hostId)) needWatch = true;
        try {
          await withHostSlot(
            () => reconcileOnce(hostId, needWatch, 0, effectiveSignal, skipDiskReload),
            effectiveSignal,
          );
          needWatch = false;
          skipDiskReload = false;
        } catch (error) {
          if (disposed || effectiveSignal?.aborted) break;
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
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const effectiveSignal = options.signal ?? serviceSignal;
    if (disposed || !started || effectiveSignal?.aborted || store.migrationBlocked() !== null)
      return;
    const primary = await resolvePrimaryHostId();
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    for (const h of hosts) {
      hostNames.set(h.id, h.name);
      if (h.id === primary || h.id === options.excludeHostId) continue;
      if (h.status !== "connected" || h.lifecycle.phase !== "active") continue;
      void syncHost(h.id, options.ensureWatch ?? false, { signal: effectiveSignal });
    }
  }

  /** Awaits sync across connected non-primary hosts (or one specific host when `targetHostId` is set). */
  async function syncNowAll(targetHostId?: string): Promise<HostSyncStatus[]> {
    const blocked = store.migrationBlocked();
    if (blocked) {
      throw new Error(`Mirror sync blocked: ${blocked}`);
    }
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
    if (targets.length > 0) {
      await ensureFreshServerState(true);
    }
    await Promise.all(targets.map((h) => syncHost(h.id, true, { skipDiskReload: true })));
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
      const info = await host.call("mirrorInfo", null, hostCallOptions(hostId, serviceSignal));
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
      serviceSignal = signal;
      await syncAllConnected({ ensureWatch: true, signal });

      const unsubHosts = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.id && event.changes.includes("host-connected")) {
            workerExitAttempts.delete(event.id);
            clearWorkerExitTimer(event.id);
            void refreshHostNames().then(() => syncHost(event.id!, true, { signal }));
          }
        },
      });
      const unsubSignals = host.experimental_onSignal("mirrorChanged", ({ hostId }) => {
        void syncHost(hostId, false, { signal });
      });
      const unsubExits = host.experimental_onWorkerExit(({ hostId }) => {
        if (disposed || signal.aborted || workerExitTimers.has(hostId)) return;
        void (async () => {
          if (disposed || signal.aborted || workerExitTimers.has(hostId)) return;
          if ((await resolvePrimaryHostId()) === hostId) return;
          const hosts = await bb.sdk.hosts.list().catch(() => []);
          const target = hosts.find((h) => h.id === hostId);
          if (!target || target.status !== "connected" || target.lifecycle.phase !== "active") {
            return;
          }
          if (disposed || signal.aborted || workerExitTimers.has(hostId)) return;
          const attempt = workerExitAttempts.get(hostId) ?? 0;
          workerExitAttempts.set(hostId, attempt + 1);
          const delayMs = Math.min(
            WORKER_EXIT_MAX_DELAY_MS,
            workerExitBaseDelayMs * 2 ** Math.min(attempt, 10),
          );
          const retryTimer = setTimeout(() => {
            workerExitTimers.delete(hostId);
            if (disposed || signal.aborted) return;
            void syncHost(hostId, true, { signal });
          }, delayMs);
          retryTimer.unref?.();
          workerExitTimers.set(hostId, retryTimer);
        })();
      });
      const timer = setInterval(() => {
        void syncAllConnected({ ensureWatch: false, signal });
      }, PERIODIC_RECONCILE_MS);
      timer.unref?.();

      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      disposed = true;
      clearInterval(timer);
      clearAllWorkerExitTimers();
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
      clearAllWorkerExitTimers();
    },
  };
}

export type SyncManager = ReturnType<typeof openSyncManager>;
