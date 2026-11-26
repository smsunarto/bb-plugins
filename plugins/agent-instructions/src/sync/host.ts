import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchEvent,
  ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { syncHostSignals } from "./host-contract.ts";
import {
  deleteSyncFileAndPrune,
  ensureSourceFolders,
  isIgnoredEntryName,
  READ_BATCH_BYTES,
  readSyncFile,
  sameManifest,
  walkSyncTree,
  writeSyncFileAtomic,
  type SyncManifest,
} from "./paths.ts";

type Signals = typeof syncHostSignals;
type Context = ExperimentalHostRpcContext<Signals>;

const WATCH_DEBOUNCE_MS = 250;
const WATCH_MAX_WAIT_MS = 1_500;

let activeWatch: {
  mirrorDir: string;
  subscription: ExperimentalHostWatchSubscription;
} | null = null;
let watchStarting: Promise<void> | null = null;
let lastKnownManifest: SyncManifest = {};
let applying = 0;
let pendingAfterApply = false;
let checkQueue: Promise<void> = Promise.resolve();

function pathsFor(context: Context) {
  return {
    mirrorDir: join(context.experimental_paths.dataDir, "mirror"),
    tmpDir: join(context.experimental_paths.dataDir, ".tmp"),
  };
}

function enqueueWatchCheck(mirrorDir: string, context: Context): void {
  checkQueue = checkQueue
    .then(async () => {
      if (context.lifecycle.signal.aborted) return;
      if (applying > 0) {
        pendingAfterApply = true;
        return;
      }
      const walked = await walkSyncTree(mirrorDir);
      if (sameManifest(walked.manifest, lastKnownManifest)) return;
      lastKnownManifest = walked.manifest;
      await context.experimental_emitSignal("mirrorChanged", { mirrorDir });
    })
    .catch(() => undefined);
}

function onWatchEvent(mirrorDir: string, context: Context) {
  return (event: ExperimentalHostWatchEvent) => {
    if (event.kind === "watch-error") return;
    if (event.kind === "changed") {
      const meaningful = event.changes.some((change) => {
        const parts = change.path.split(/[\\/]/);
        return !parts.some((p) => p && isIgnoredEntryName(p));
      });
      if (!meaningful) return;
    }
    enqueueWatchCheck(mirrorDir, context);
  };
}

async function ensureWatch(mirrorDir: string, context: Context): Promise<void> {
  await ensureSourceFolders(mirrorDir);
  if (activeWatch?.mirrorDir === mirrorDir) return;
  if (watchStarting) {
    await watchStarting;
    if (activeWatch?.mirrorDir === mirrorDir) return;
  }
  watchStarting = (async () => {
    if (activeWatch) {
      await activeWatch.subscription.dispose().catch(() => undefined);
      activeWatch = null;
    }
    const subscription = await context.experimental_watch(
      {
        rootPath: mirrorDir,
        ignoredPaths: [".git", ".DS_Store", "*.swp", "*.swo", "*.tmp", ".sync-tmp-*"],
        debounceMs: WATCH_DEBOUNCE_MS,
        maxWaitMs: WATCH_MAX_WAIT_MS,
      },
      onWatchEvent(mirrorDir, context),
    );
    activeWatch = { mirrorDir, subscription };
    context.lifecycle.signal.addEventListener(
      "abort",
      () => {
        void disposeSyncHost();
      },
      { once: true },
    );
  })().finally(() => {
    watchStarting = null;
  });
  await watchStarting;
}

export async function disposeSyncHost(): Promise<void> {
  const current = activeWatch;
  activeWatch = null;
  if (current) await current.subscription.dispose().catch(() => undefined);
}

async function insideNoSymlink(rootPath: string, path: string): Promise<string> {
  const root = await realpath(rootPath);
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`${relative(root, current)} is a link; only plain files are readable`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return join(root, path);
}

/** Host RPC handlers for maintaining and watching the plugin's editable mirror. */
export const syncHostHandlers = {
  async readText({ rootPath, path }: { rootPath: string; path: string }) {
    try {
      return { content: await readFile(await insideNoSymlink(rootPath, path), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null };
      throw error;
    }
  },

  async mirrorInfo(_input: null, context: Context) {
    const { mirrorDir } = pathsFor(context);
    await ensureSourceFolders(mirrorDir);
    return { mirrorDir };
  },

  async mirrorEnsureWatch(_input: null, context: Context) {
    const { mirrorDir } = pathsFor(context);
    await ensureWatch(mirrorDir, context);
    const walked = await walkSyncTree(mirrorDir);
    lastKnownManifest = walked.manifest;
    return { mirrorDir, ...walked };
  },

  async mirrorSnapshot(_input: null, context: Context) {
    const { mirrorDir } = pathsFor(context);
    await ensureSourceFolders(mirrorDir);
    const walked = await walkSyncTree(mirrorDir);
    lastKnownManifest = walked.manifest;
    return { mirrorDir, ...walked };
  },

  async mirrorReadFiles(input: { paths: string[] }, context: Context) {
    const { mirrorDir } = pathsFor(context);
    const files: { path: string; executable: boolean; sha256: string; base64: string }[] = [];
    const missing: string[] = [];
    let totalBytes = 0;

    for (const relPath of input.paths) {
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
    },
    context: Context,
  ) {
    const { mirrorDir, tmpDir } = pathsFor(context);
    await ensureSourceFolders(mirrorDir);
    applying++;
    const applied: string[] = [];
    const conflicts: string[] = [];
    try {
      for (const op of input.writes) {
        const current = await readSyncFile(mirrorDir, op.path);
        const currentSha = current?.sha256 ?? null;
        if (currentSha !== op.expectedSha256) {
          conflicts.push(op.path);
          continue;
        }
        const bytes = Buffer.from(op.base64, "base64");
        await writeSyncFileAtomic(mirrorDir, tmpDir, op.path, bytes, op.executable);
        applied.push(op.path);
      }
      for (const op of input.deletes) {
        const current = await readSyncFile(mirrorDir, op.path);
        if (current === null) {
          applied.push(op.path);
          continue;
        }
        if (current.sha256 !== op.expectedSha256) {
          conflicts.push(op.path);
          continue;
        }
        await deleteSyncFileAndPrune(mirrorDir, op.path);
        applied.push(op.path);
      }
      const walked = await walkSyncTree(mirrorDir);
      lastKnownManifest = walked.manifest;
      return { applied, conflicts, manifest: walked.manifest };
    } finally {
      applying--;
      if (applying === 0 && pendingAfterApply) {
        pendingAfterApply = false;
        enqueueWatchCheck(mirrorDir, context);
      }
    }
  },
};
