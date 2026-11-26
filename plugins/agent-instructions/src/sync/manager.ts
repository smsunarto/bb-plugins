import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { hostContract, hostSignals } from "../host-contract.ts";
import type { SourceStore } from "../source/store.ts";
import {
  conflictPathFor,
  conflictTimestamp,
  deleteSyncFileAndPrune,
  readSyncFile,
  sameDigest,
  sanitizeSlug,
  sha256Bytes,
  WRITE_BATCH_BYTES,
  writeSyncFileAtomic,
  type SyncManifest,
} from "./paths.ts";
import { planSync } from "./reconcile.ts";

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

function isSafeHostId(hostId: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(hostId);
}

/**
 * Coordinates two-way synchronization between the server's `source/` folder and
 * each enrolled non-primary host's `<hostDataDir>/mirror/` folder.
 *
 * Hosts reconcile independently so a slow or offline machine never blocks others.
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
  const hostPromises = new Map<string, Promise<void>>();

  function stateFileFor(hostId: string): string {
    if (!isSafeHostId(hostId)) throw new Error(`Invalid host id: ${JSON.stringify(hostId)}`);
    return join(syncStateDir, `${hostId}.json`);
  }

  async function readBase(hostId: string): Promise<SyncManifest> {
    try {
      const parsed = JSON.parse(await readFile(stateFileFor(hostId), "utf8")) as PersistedSyncState;
      if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object")
        return parsed.files;
    } catch {
      // Cold start: empty base manifest.
    }
    return {};
  }

  async function writeBase(hostId: string, files: SyncManifest): Promise<void> {
    await mkdir(syncStateDir, { recursive: true });
    await mkdir(store.tmpDir, { recursive: true });
    const staged = join(store.tmpDir, `.sync-state-${randomBytes(6).toString("hex")}`);
    const payload: PersistedSyncState = { version: 1, syncedAt: Date.now(), files };
    await writeFile(staged, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(staged, stateFileFor(hostId));
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
    } catch {
      primaryHostId = null;
    }
    return primaryHostId;
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
      const batch = remaining.slice(0, 200);
      const response = await host.call(
        "mirrorReadFiles",
        { paths: batch },
        { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
      );
      const handled = new Set<string>(response.missing);
      for (const file of response.files) {
        handled.add(file.path);
        const bytes = Buffer.from(file.base64, "base64");
        if (sha256Bytes(bytes) !== file.sha256) {
          bb.log.warn(`sync(${hostId}): sha256 mismatch on ${file.path}; skipping`);
          continue;
        }
        result.set(file.path, { bytes, executable: file.executable, sha256: file.sha256 });
      }
      if (handled.size === 0) break;
      remaining = remaining.filter((p) => !handled.has(p));
    }
    return result;
  }

  /** Sends push writes & deletes to `hostId` in bounded batches with per-file CAS. */
  async function pushToHost(
    hostId: string,
    writes: { path: string; executable: boolean; bytes: Buffer; expectedSha256: string | null }[],
    deletes: { path: string; expectedSha256: string }[],
  ): Promise<{ applied: Set<string>; conflicts: Set<string>; manifest: SyncManifest | null }> {
    const applied = new Set<string>();
    const conflicts = new Set<string>();
    let latestManifest: SyncManifest | null = null;

    // Split writes into <= WRITE_BATCH_BYTES chunks; attach deletes on the final batch.
    const writeBatches: (typeof writes)[] = [];
    let current: typeof writes = [];
    let currentBytes = 0;
    for (const item of writes) {
      if (
        current.length > 0 &&
        (currentBytes + item.bytes.length > WRITE_BATCH_BYTES || current.length >= 200)
      ) {
        writeBatches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += item.bytes.length;
    }
    if (current.length > 0 || deletes.length > 0) writeBatches.push(current);

    for (let i = 0; i < writeBatches.length; i++) {
      const batchWrites = writeBatches[i]!;
      const batchDeletes = i === writeBatches.length - 1 ? deletes : [];
      const res = await host.call(
        "mirrorApplyOps",
        {
          writes: batchWrites.map((w) => ({
            path: w.path,
            executable: w.executable,
            base64: w.bytes.toString("base64"),
            expectedSha256: w.expectedSha256,
          })),
          deletes: batchDeletes,
        },
        { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
      );
      for (const p of res.applied) applied.add(p);
      for (const p of res.conflicts) conflicts.add(p);
      latestManifest = res.manifest;
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

    // Snapshot server state and base manifest.
    await store.reloadFromDisk("disk");
    const serverBefore = store.manifest();
    const base = await readBase(hostId);
    const hostSlug = sanitizeSlug(hostNames.get(hostId) ?? hostId);
    const ts = conflictTimestamp();

    const plan = planSync({
      server: serverBefore,
      host: snapshot.manifest,
      base,
      hostSlug,
      timestamp: ts,
    });

    const pathsToRead = [...plan.pullWrites, ...plan.conflicts.map((c) => c.path)];
    const fetched = pathsToRead.length > 0 ? await fetchHostFiles(hostId, pathsToRead) : new Map();

    // Apply pulls & conflict copies under the server source lock, re-checking server sha256!
    const extraConflictPushes: string[] = [];
    let serverMutated = false;

    const serverAfterPull = await store.withLock(async () => {
      await store.reloadUnlocked("disk");
      const currentServer = store.manifest();

      for (const path of plan.pullWrites) {
        const file = fetched.get(path);
        if (!file) continue;
        // Re-check server did not diverge while we fetched over the network.
        if (!sameDigest(currentServer[path], serverBefore[path])) {
          // Late race on server: preserve host's bytes in conflicts/ instead of clobbering.
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
        await writeSyncFileAtomic(store.sourceDir, store.tmpDir, path, file.bytes, file.executable);
        serverMutated = true;
      }

      for (const path of plan.pullDeletes) {
        if (!sameDigest(currentServer[path], serverBefore[path])) continue;
        if (await deleteSyncFileAndPrune(store.sourceDir, path)) serverMutated = true;
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

    // Build pushes from the post-pull server state (including newly written conflict copies).
    const pushWriteList: {
      path: string;
      executable: boolean;
      bytes: Buffer;
      expectedSha256: string | null;
    }[] = [];
    const seenPush = new Set<string>();
    for (const op of plan.pushWrites) {
      seenPush.add(op.path);
      const read = await readSyncFile(store.sourceDir, op.path);
      if (!read) continue;
      pushWriteList.push({
        path: op.path,
        executable: read.executable,
        bytes: read.bytes,
        expectedSha256: op.expectedHostSha256,
      });
    }
    for (const conflictPath of extraConflictPushes) {
      if (seenPush.has(conflictPath)) continue;
      const read = await readSyncFile(store.sourceDir, conflictPath);
      if (!read) continue;
      pushWriteList.push({
        path: conflictPath,
        executable: read.executable,
        bytes: read.bytes,
        expectedSha256: snapshot.manifest[conflictPath]?.sha256 ?? null,
      });
    }

    const pushDeleteList = plan.pushDeletes.map((d) => ({
      path: d.path,
      expectedSha256: d.expectedHostSha256,
    }));

    const pushed =
      pushWriteList.length > 0 || pushDeleteList.length > 0
        ? await pushToHost(hostId, pushWriteList, pushDeleteList)
        : { applied: new Set<string>(), conflicts: new Set<string>(), manifest: snapshot.manifest };

    // Compute the new base manifest: only advance paths that actually converged.
    const hostFinal = pushed.manifest ?? snapshot.manifest;
    const nextBase: SyncManifest = {};
    const allKeys = new Set<string>([
      ...Object.keys(serverAfterPull),
      ...Object.keys(hostFinal),
      ...Object.keys(base),
    ]);
    for (const key of allKeys) {
      if (pushed.conflicts.has(key)) {
        if (base[key]) nextBase[key] = base[key]!;
        continue;
      }
      if (sameDigest(serverAfterPull[key], hostFinal[key])) {
        if (serverAfterPull[key]) nextBase[key] = serverAfterPull[key]!;
      } else if (base[key]) {
        nextBase[key] = base[key]!;
      }
    }
    await writeBase(hostId, nextBase);

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

  /** Serializes reconciles per host: at most 1 active + 1 coalesced rerun. */
  function syncHost(hostId: string, ensureWatchFirst = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight.has(hostId)) {
      pendingAgain.add(hostId);
      return hostPromises.get(hostId) ?? Promise.resolve();
    }
    inFlight.add(hostId);
    const run = (async () => {
      let needWatch = ensureWatchFirst;
      while (!disposed) {
        pendingAgain.delete(hostId);
        try {
          await reconcileOnce(hostId, needWatch, 0);
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
        needWatch = false;
        if (!pendingAgain.has(hostId)) break;
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

  /** Awaits sync across every connected non-primary host (used by `bb agent-instructions sync`). */
  async function syncNowAll(): Promise<HostSyncStatus[]> {
    const primary = await resolvePrimaryHostId();
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    const targets = hosts.filter(
      (h) => h.id !== primary && h.status === "connected" && h.lifecycle.phase === "active",
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
      await refreshHostNames();
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
    status: (): HostSyncStatus[] => [...hostStatus.values()],
    dispose(): void {
      disposed = true;
    },
  };
}

export type SyncManager = ReturnType<typeof openSyncManager>;
