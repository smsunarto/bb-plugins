import { createHash } from "node:crypto";
import { watch as watchFolder, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import { docsHostContract, docsHostSignals, VAULT_CHANGE_PATH_LIMIT } from "./host-contract.js";
import { DOCS_WATCH_IGNORED_PATHS, isExcludedDocsPath } from "./path-policy.js";

type ListedPath =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; modifiedAtMs: number; sizeBytes: number };

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

// A missing root is an error the user must see. Swallowing it would show
// an empty vault, which looks the same as a vault on the wrong machine.
async function requireDirectory(rootPath: string): Promise<void> {
  if (!path.isAbsolute(rootPath)) throw new Error("Path must be absolute");
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(rootPath)).isDirectory();
  } catch (error) {
    if (isMissingPath(error)) throw new Error(`Folder not found: ${rootPath}`, { cause: error });
    throw error;
  }
  if (!isDirectory) throw new Error(`Not a folder: ${rootPath}`);
}

/** Largest opened file a change signal hashes; a bigger one reports no hash. */
const MAX_HASHED_BYTES = 8 * 1024 * 1024;
/**
 * Largest vault file a change batch hashes. The hashes only let the server
 * drop the echo of a note it saved, and a synced folder of attachments
 * would otherwise be read whole. A bigger file reports no hash: a change.
 */
const MAX_VAULT_HASHED_BYTES = 1024 * 1024;
/** How many of a change batch's files are hashed at once. */
const VAULT_HASH_CONCURRENCY = 4;

// The same hex digest of the raw bytes that bb's file reads report, computed
// here so a change can be compared without moving the file off the host.
async function fileSha256(fullPath: string, maxBytes = MAX_HASHED_BYTES): Promise<string | null> {
  try {
    const stats = await stat(fullPath);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return createHash("sha256")
      .update(await readFile(fullPath))
      .digest("hex");
  } catch {
    return null;
  }
}

async function statOne(input: { path: string }) {
  if (!path.isAbsolute(input.path)) throw new Error("Path must be absolute");
  try {
    const stats = await stat(input.path);
    return {
      file: stats.isFile() ? { modifiedAtMs: stats.mtimeMs, sizeBytes: stats.size } : null,
    };
  } catch (error) {
    if (isMissingPath(error)) return { file: null };
    throw error;
  }
}

// A folder removed mid-walk drops only that subtree.
async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

// The server re-reads a note only when its time or size changes.
async function statFile(fullPath: string, relativePath: string): Promise<ListedPath | null> {
  try {
    const stats = await stat(fullPath);
    return { kind: "file", path: relativePath, modifiedAtMs: stats.mtimeMs, sizeBytes: stats.size };
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

async function listPaths(input: {
  path: string;
  includeFiles: boolean;
  includeDirectories: boolean;
  limit: number;
  signal: AbortSignal;
}): Promise<{ paths: ListedPath[]; truncated: boolean }> {
  await requireDirectory(input.path);

  const paths: ListedPath[] = [];
  let truncated = false;
  const append = (entry: ListedPath): boolean => {
    if (paths.length >= input.limit) {
      truncated = true;
      return false;
    }
    paths.push(entry);
    return true;
  };

  const visit = async (directory: string): Promise<void> => {
    input.signal.throwIfAborted();
    for (const entry of await readDirectory(directory)) {
      input.signal.throwIfAborted();
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(input.path, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory() && isExcludedDocsPath(relativePath)) continue;
      if (entry.isDirectory()) {
        if (input.includeDirectories && !append({ kind: "directory", path: relativePath })) return;
        await visit(fullPath);
      } else if (entry.isFile() && input.includeFiles) {
        const file = await statFile(fullPath, relativePath);
        if (file && !append(file)) return;
      }
    }
  };

  await visit(input.path);
  return { paths, truncated };
}

const watches = new Map<
  string,
  { rootPath: string; subscription: Promise<ExperimentalHostWatchSubscription> }
>();

async function unwatchVault(input: { vaultId: string }): Promise<{ ok: true }> {
  const watch = watches.get(input.vaultId);
  watches.delete(input.vaultId);
  await watch?.subscription.then((live) => live.dispose()).catch(() => {});
  return { ok: true };
}

// The watch outlives this call and keeps the worker alive. Re-watching a
// vault replaces its watch; a worker exit drops it and the server re-arms.
async function watchVault(
  input: { vaultId: string; rootPath: string },
  context: ExperimentalHostRpcContext<typeof docsHostSignals>,
): Promise<{ ok: true }> {
  await unwatchVault({ vaultId: input.vaultId });
  await requireDirectory(input.rootPath);
  const subscription = context.experimental_watch(
    { rootPath: input.rootPath, ignoredPaths: DOCS_WATCH_IGNORED_PATHS, debounceMs: 250 },
    async (event) => {
      let changes: { path: string; sha256: string | null }[] | undefined;
      if (event.kind === "changed") {
        const paths = [
          ...new Set(
            event.changes.map((change) =>
              (path.isAbsolute(change.path)
                ? path.relative(input.rootPath, change.path)
                : change.path
              ).replace(/\\/g, "/"),
            ),
          ),
        ].filter((relativePath) => !isExcludedDocsPath(relativePath));
        if (paths.length === 0) return;
        if (paths.length <= VAULT_CHANGE_PATH_LIMIT) {
          const hashed: { path: string; sha256: string | null }[] = [];
          let next = 0;
          const hashNext = async (): Promise<void> => {
            while (next < paths.length) {
              const relativePath = paths[next++]!;
              const fullPath = path.join(input.rootPath, relativePath);
              hashed.push({
                path: relativePath,
                sha256: await fileSha256(fullPath, MAX_VAULT_HASHED_BYTES),
              });
            }
          };
          await Promise.all(Array.from({ length: VAULT_HASH_CONCURRENCY }, hashNext));
          const order = new Map(paths.map((relativePath, index) => [relativePath, index]));
          changes = hashed.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
        }
      }
      await context
        .experimental_emitSignal("vaultChanged", {
          vaultId: input.vaultId,
          kind: event.kind,
          ...(changes ? { changes } : {}),
        })
        .catch(() => {});
    },
  );
  const watch = { rootPath: input.rootPath, subscription };
  watches.set(input.vaultId, watch);
  try {
    await subscription;
  } catch (error) {
    if (watches.get(input.vaultId) === watch) watches.delete(input.vaultId);
    throw error;
  }
  return { ok: true };
}

// A daemon restart drops every watch without a worker exit, and a deleted
// root can end its watch without an error. Report only the watches still
// held on a folder that still exists, so the server re-arms the rest.
async function watchAlive(input: { vaultIds: string[] }): Promise<{ live: string[] }> {
  const live: string[] = [];
  for (const vaultId of input.vaultIds) {
    const watch = watches.get(vaultId);
    if (!watch) continue;
    const exists = await requireDirectory(watch.rootPath).then(
      () => true,
      () => false,
    );
    if (exists) live.push(vaultId);
    else if (watches.get(vaultId) === watch) await unwatchVault({ vaultId });
  }
  return { live };
}

/** Quiet period before an opened file's burst of writes, such as an atomic save, is one change. */
const FILE_WATCH_DEBOUNCE_MS = 250;

const fileWatches = new Map<
  string,
  { path: string; stop: () => Promise<void>; expiry: ReturnType<typeof setTimeout> }
>();

async function unwatchFile(watchId: string): Promise<void> {
  const watch = fileWatches.get(watchId);
  if (!watch) return;
  fileWatches.delete(watchId);
  clearTimeout(watch.expiry);
  await watch.stop().catch(() => {});
}

// An open document outside every vault. The page renews the lease while it
// shows the file, so a closed tab's watch lapses on its own. A failed watch
// still answers the hash, and the next renewal tries to watch again.
async function watchFile(
  input: { watchId: string; path: string; leaseMs: number },
  context: ExperimentalHostRpcContext<typeof docsHostSignals>,
): Promise<{ sha256: string | null }> {
  if (!path.isAbsolute(input.path)) throw new Error("Path must be absolute");
  const { watchId, leaseMs } = input;
  const filePath = path.normalize(input.path);
  const expire = () => setTimeout(() => void unwatchFile(watchId), leaseMs);
  // Another call can start a watch while this one stops the old one, so
  // check again after every wait; the new watch is set up without one.
  let existing = fileWatches.get(watchId);
  while (existing !== undefined && existing.path !== filePath) {
    await unwatchFile(watchId);
    existing = fileWatches.get(watchId);
  }
  if (existing) {
    clearTimeout(existing.expiry);
    existing.expiry = expire();
  } else {
    // The file's own folder and not the folders under it: the daemon's
    // watcher takes a whole tree, and an opened ~/AGENTS.md would watch $HOME.
    const name = path.basename(filePath);
    const lease = context.experimental_retainWorker();
    let folder: FSWatcher | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const watch = {
      path: filePath,
      stop: async () => {
        if (pending) clearTimeout(pending);
        folder?.close();
        await lease.dispose();
      },
      expiry: expire(),
    };
    fileWatches.set(watchId, watch);
    const report = async () => {
      if (fileWatches.get(watchId) !== watch) return;
      await context
        .experimental_emitSignal("fileChanged", { watchId, sha256: await fileSha256(filePath) })
        .catch(() => {});
    };
    try {
      folder = watchFolder(path.dirname(filePath), { persistent: false }, (_kind, changed) => {
        // A platform that names no file may mean this one.
        if (changed !== null && changed.toString() !== name) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          void report();
        }, FILE_WATCH_DEBOUNCE_MS);
      });
      folder.on("error", () => {
        if (fileWatches.get(watchId) === watch) void unwatchFile(watchId);
      });
    } catch {
      if (fileWatches.get(watchId) === watch) await unwatchFile(watchId);
    }
  }
  return { sha256: await fileSha256(filePath) };
}

export default experimental_defineHostEntry({
  contract: docsHostContract,
  experimental_signals: docsHostSignals,
  handlers: {
    listPaths: (input, context) => listPaths({ ...input, signal: context.signal }),
    watchVault: (input, context) => watchVault(input, context),
    unwatchVault: (input) => unwatchVault(input),
    watchAlive: (input) => watchAlive(input),
    statFile: (input) => statOne(input),
    watchFile: (input, context) => watchFile(input, context),
  },
  dispose: async () => {
    await Promise.all([
      ...[...watches.keys()].map((vaultId) => unwatchVault({ vaultId })),
      ...[...fileWatches.keys()].map((watchId) => unwatchFile(watchId)),
    ]);
  },
});
