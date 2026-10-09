import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import { docsHostContract, docsHostSignals } from "./host-contract.js";
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
      if (
        event.kind === "changed" &&
        event.changes.every((change) =>
          isExcludedDocsPath(
            path.isAbsolute(change.path) ? path.relative(input.rootPath, change.path) : change.path,
          ),
        )
      ) {
        return;
      }
      await context
        .experimental_emitSignal("vaultChanged", { vaultId: input.vaultId, kind: event.kind })
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

export default experimental_defineHostEntry({
  contract: docsHostContract,
  experimental_signals: docsHostSignals,
  handlers: {
    listPaths: (input, context) => listPaths({ ...input, signal: context.signal }),
    watchVault: (input, context) => watchVault(input, context),
    unwatchVault: (input) => unwatchVault(input),
    watchAlive: (input) => watchAlive(input),
  },
  dispose: async () => {
    await Promise.all([...watches.keys()].map((vaultId) => unwatchVault({ vaultId })));
  },
});
