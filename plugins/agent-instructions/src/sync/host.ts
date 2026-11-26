import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchEvent,
  ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import { join } from "node:path";
import type { syncHostSignals } from "./host-contract.ts";
import {
  DEFAULT_SYNC_IO_CONCURRENCY,
  deleteSyncFileAndPrune,
  ensureSourceFolders,
  isIgnoredEntryName,
  READ_BATCH_BYTES,
  readSyncFile,
  runWithConcurrency,
  sameManifest,
  throwIfAborted,
  walkSyncTree,
  writeSyncFileAtomic,
  type SyncManifest,
  type WalkStatCache,
} from "./paths.ts";

type Signals = typeof syncHostSignals;
type Context = ExperimentalHostRpcContext<Signals>;

const WATCH_DEBOUNCE_MS = 250;
const WATCH_MAX_WAIT_MS = 1_500;

type MirrorState = {
  mirrorDir: string;
  activeWatch: ExperimentalHostWatchSubscription | null;
  watchStarting: Promise<void> | null;
  abortListenerAttached: boolean;
  lastKnownManifest: SyncManifest;
  statCache: WalkStatCache;
  applying: number;
  pendingAfterApply: boolean;
  checkRunning: boolean;
  checkPending: boolean;
};

const mirrorStates = new Map<string, MirrorState>();

function stateFor(mirrorDir: string): MirrorState {
  let state = mirrorStates.get(mirrorDir);
  if (!state) {
    state = {
      mirrorDir,
      activeWatch: null,
      watchStarting: null,
      abortListenerAttached: false,
      lastKnownManifest: Object.create(null) as SyncManifest,
      statCache: new Map(),
      applying: 0,
      pendingAfterApply: false,
      checkRunning: false,
      checkPending: false,
    };
    mirrorStates.set(mirrorDir, state);
  }
  return state;
}

function pathsFor(context: Context) {
  return {
    mirrorDir: join(context.experimental_paths.dataDir, "mirror"),
    tmpDir: join(context.experimental_paths.dataDir, ".tmp"),
  };
}

/** Coalesced watch check: at most 1 active scan + 1 pending re-scan per mirrorDir. */
function enqueueWatchCheck(state: MirrorState, context: Context): void {
  if (context.lifecycle.signal.aborted) return;
  if (state.applying > 0) {
    state.pendingAfterApply = true;
    return;
  }
  if (state.checkRunning) {
    state.checkPending = true;
    return;
  }
  state.checkRunning = true;
  void (async () => {
    try {
      while (!context.lifecycle.signal.aborted) {
        state.checkPending = false;
        if (state.applying > 0) {
          state.pendingAfterApply = true;
          return;
        }
        const walked = await walkSyncTree(state.mirrorDir, {
          statCache: state.statCache,
          signal: context.lifecycle.signal,
        });
        if (!sameManifest(walked.manifest, state.lastKnownManifest)) {
          state.lastKnownManifest = walked.manifest;
          await context.experimental_emitSignal("mirrorChanged", { mirrorDir: state.mirrorDir });
        }
        if (!state.checkPending) break;
      }
    } catch {
      // Transient filesystem errors during rapid edits are retried on the next event or periodic reconcile.
    } finally {
      state.checkRunning = false;
    }
  })();
}

function onWatchEvent(state: MirrorState, context: Context) {
  return (event: ExperimentalHostWatchEvent) => {
    if (event.kind === "watch-error") {
      const broken = state.activeWatch;
      state.activeWatch = null;
      if (broken) void broken.dispose().catch(() => undefined);
      return;
    }
    if (event.kind === "changed") {
      const meaningful = event.changes.some((change) => {
        const parts = change.path.split(/[\\/]/);
        return !parts.some((p) => p && isIgnoredEntryName(p));
      });
      if (!meaningful) return;
    }
    enqueueWatchCheck(state, context);
  };
}

async function disposeMirrorState(state: MirrorState): Promise<void> {
  const current = state.activeWatch;
  state.activeWatch = null;
  state.watchStarting = null;
  state.pendingAfterApply = false;
  state.checkPending = false;
  if (current) await current.dispose().catch(() => undefined);
}

async function ensureWatch(mirrorDir: string, context: Context): Promise<void> {
  throwIfAborted(context.signal);
  await ensureSourceFolders(mirrorDir);
  const state = stateFor(mirrorDir);
  if (state.activeWatch) return;
  if (state.watchStarting) {
    await state.watchStarting;
    if (state.activeWatch) return;
  }
  state.watchStarting = (async () => {
    const subscription = await context.experimental_watch(
      {
        rootPath: mirrorDir,
        ignoredPaths: [".git", ".DS_Store", "*.swp", "*.swo", "*.tmp", ".sync-tmp-*"],
        debounceMs: WATCH_DEBOUNCE_MS,
        maxWaitMs: WATCH_MAX_WAIT_MS,
      },
      onWatchEvent(state, context),
    );
    state.activeWatch = subscription;
    if (!state.abortListenerAttached) {
      state.abortListenerAttached = true;
      context.lifecycle.signal.addEventListener(
        "abort",
        () => {
          void disposeMirrorState(state).finally(() => mirrorStates.delete(mirrorDir));
        },
        { once: true },
      );
    }
  })().finally(() => {
    state.watchStarting = null;
  });
  await state.watchStarting;
}

export async function disposeSyncHost(): Promise<void> {
  const states = [...mirrorStates.values()];
  mirrorStates.clear();
  for (const state of states) await disposeMirrorState(state);
}

/** Host RPC handlers for maintaining and watching the plugin's editable mirror. */
export const syncHostHandlers = {
  async mirrorInfo(_input: null, context: Context) {
    throwIfAborted(context.signal);
    const { mirrorDir } = pathsFor(context);
    await ensureSourceFolders(mirrorDir);
    return { mirrorDir };
  },

  async mirrorEnsureWatch(_input: null, context: Context) {
    throwIfAborted(context.signal);
    const { mirrorDir } = pathsFor(context);
    await ensureWatch(mirrorDir, context);
    const state = stateFor(mirrorDir);
    const walked = await walkSyncTree(mirrorDir, {
      statCache: state.statCache,
      signal: context.signal,
    });
    state.lastKnownManifest = walked.manifest;
    return { mirrorDir, ...walked };
  },

  async mirrorSnapshot(_input: null, context: Context) {
    throwIfAborted(context.signal);
    const { mirrorDir } = pathsFor(context);
    await ensureSourceFolders(mirrorDir);
    const state = stateFor(mirrorDir);
    const walked = await walkSyncTree(mirrorDir, {
      statCache: state.statCache,
      signal: context.signal,
    });
    state.lastKnownManifest = walked.manifest;
    return { mirrorDir, ...walked };
  },

  async mirrorReadFiles(input: { paths: string[] }, context: Context) {
    throwIfAborted(context.signal);
    const { mirrorDir } = pathsFor(context);
    const files: { path: string; executable: boolean; sha256: string; base64: string }[] = [];
    const missing: string[] = [];
    let totalBytes = 0;

    for (const relPath of input.paths) {
      throwIfAborted(context.signal);
      const read = await readSyncFile(mirrorDir, relPath);
      if (read === null) {
        missing.push(relPath);
        continue;
      }
      // Keep each response safely below the 8 MiB daemon output limit.
      if (files.length > 0 && totalBytes + read.bytes.length > READ_BATCH_BYTES) break;
      totalBytes += read.bytes.length;
      files.push({
        path: relPath,
        executable: read.executable,
        sha256: read.sha256,
        base64: read.bytes.toString("base64"),
      });
    }
    return { files, missing };
  },

  async mirrorApplyOps(
    input: {
      writes: {
        path: string;
        executable: boolean;
        base64: string;
        expectedSha256: string | null;
      }[];
      deletes: { path: string; expectedSha256: string }[];
      includeManifest?: boolean;
    },
    context: Context,
  ) {
    throwIfAborted(context.signal);
    const { mirrorDir, tmpDir } = pathsFor(context);
    await ensureSourceFolders(mirrorDir);
    const state = stateFor(mirrorDir);
    state.applying++;
    const applied: string[] = [];
    const conflicts: string[] = [];
    try {
      // Execute deletes BEFORE writes so file<->directory replacements never hit ENOTDIR/EISDIR.
      await runWithConcurrency(
        input.deletes,
        DEFAULT_SYNC_IO_CONCURRENCY,
        async (op) => {
          throwIfAborted(context.signal);
          const current = await readSyncFile(mirrorDir, op.path);
          if (current === null) {
            applied.push(op.path);
            delete state.lastKnownManifest[op.path];
            state.statCache.delete(op.path);
            return;
          }
          if (current.sha256 !== op.expectedSha256) {
            conflicts.push(op.path);
            return;
          }
          await deleteSyncFileAndPrune(mirrorDir, op.path);
          applied.push(op.path);
          delete state.lastKnownManifest[op.path];
          state.statCache.delete(op.path);
        },
        context.signal,
      );

      await runWithConcurrency(
        input.writes,
        DEFAULT_SYNC_IO_CONCURRENCY,
        async (op) => {
          throwIfAborted(context.signal);
          const current = await readSyncFile(mirrorDir, op.path);
          const currentSha = current?.sha256 ?? null;
          if (currentSha !== op.expectedSha256) {
            conflicts.push(op.path);
            return;
          }
          const bytes = Buffer.from(op.base64, "base64");
          const written = await writeSyncFileAtomic(
            mirrorDir,
            tmpDir,
            op.path,
            bytes,
            op.executable,
          );
          applied.push(op.path);
          state.lastKnownManifest[op.path] = {
            sha256: written.sha256,
            executable: op.executable,
            size: written.size,
          };
          state.statCache.delete(op.path);
        },
        context.signal,
      );

      if (input.includeManifest === false) {
        return { applied, conflicts };
      }
      const walked = await walkSyncTree(mirrorDir, {
        statCache: state.statCache,
        signal: context.signal,
      });
      // Keep `state.lastKnownManifest` reflecting only what we applied so any concurrent
      // local edit to an unrelated path still triggers `mirrorChanged` on the watch check.
      return { applied, conflicts, manifest: walked.manifest };
    } finally {
      state.applying--;
      if (state.applying === 0 && state.pendingAfterApply) {
        state.pendingAfterApply = false;
        enqueueWatchCheck(state, context);
      }
    }
  },
};
