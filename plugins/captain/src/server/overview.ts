import { createHash, type Hash } from "node:crypto";
import { type Dirent, lstatSync, opendirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DRIVE_EXCERPT_BYTES, type CrewThreadItem, type DriveFileItem } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { ensureStorageRoot } from "./commands/deps.ts";
import { isActive, joinCrew } from "./crew.ts";
import { DRIVE_FILES, isInside, readInside } from "./drive.ts";
import { READ_DEADLINE_MS, type CrewSnapshot } from "./queue.ts";
import { ROLE_SPECS } from "./roles.ts";

/**
 * The Overview tab's reads: the Captain's crew as rows, and its Drive as
 * cards. Asks come from the banner's own `asks` read.
 */

/** How long a provider's model names are reused before they are read again. */
const MODEL_NAMES_TTL_MS = 10 * 60_000;

/**
 * Each crew thread's model, and each provider's model display names. A thread
 * keeps its model for life (a fallback restarts on a new thread), so its model
 * is read once. A provider's catalog is kept for the TTL once read; a read in
 * flight is shared by its concurrent callers only, and a failed or late read
 * is not kept, so the next read asks again.
 */
export function createModelNames(deps: Pick<CommandDeps, "bb">, now: () => number = Date.now) {
  const threadModels = new Map<string, string | null>();
  const catalogs = new Map<string, { at: number; names: Map<string, string> }>();
  const reading = new Map<string, Promise<Map<string, string> | null>>();

  function catalog(providerId: string): Promise<Map<string, string> | null> {
    const kept = catalogs.get(providerId);
    if (kept !== undefined && now() - kept.at < MODEL_NAMES_TTL_MS) {
      return Promise.resolve(kept.names);
    }
    const inFlight = reading.get(providerId);
    if (inFlight !== undefined) return inFlight;
    const read = deps.bb.sdk.providers
      .models({ providerId, preferCached: true, signal: AbortSignal.timeout(READ_DEADLINE_MS) })
      .then(
        (result) => {
          const names = new Map(result.models.map((model) => [model.model, model.displayName]));
          catalogs.set(providerId, { at: now(), names });
          return names;
        },
        // Unread: an expired catalog is still better than raw ids.
        () => kept?.names ?? null,
      )
      .finally(() => reading.delete(providerId));
    reading.set(providerId, read);
    return read;
  }

  async function modelOf(threadId: string, signal: AbortSignal): Promise<string | null> {
    if (threadModels.has(threadId)) return threadModels.get(threadId) ?? null;
    const model = await deps.bb.sdk.threads
      .defaultExecutionOptions({ threadId, signal })
      .then((options) => options?.model ?? null)
      .catch(() => undefined);
    // An unreadable model is asked again next read; a missing one is remembered.
    if (model !== undefined) threadModels.set(threadId, model);
    return model ?? null;
  }

  return async (
    thread: { id: string; providerId: string },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const model = await modelOf(thread.id, signal);
    if (model === null) return null;
    return (await catalog(thread.providerId))?.get(model) ?? model;
  };
}

export type ModelNames = ReturnType<typeof createModelNames>;

/**
 * The Captain's unarchived crew: active first, then the most recently
 * updated. A Tasks failure keeps every thread and drops only its task.
 */
export async function crewThreads(
  deps: Pick<CommandDeps, "store">,
  readCrew: (captainId: string) => CrewSnapshot,
  modelName: ModelNames,
  captainId: string,
): Promise<CrewThreadItem[]> {
  const crew = readCrew(captainId);
  const threads = await crew.threads;
  const signal = AbortSignal.timeout(READ_DEADLINE_MS);
  // Models need only the threads: they are read while Tasks answers.
  const [rows, models] = await Promise.all([
    crew.rows,
    Promise.all(threads.map((thread) => modelName(thread, signal))),
  ]);
  return joinCrew(deps, threads, rows)
    .map(({ thread, role, rows: own }, index) => ({
      id: thread.id,
      title: thread.title ?? thread.titleFallback ?? thread.id,
      status: thread.status,
      providerId: thread.providerId,
      model: models[index] ?? null,
      task: own[0]?.task.key ?? null,
      role: role === null ? null : ROLE_SPECS[role].label,
      hasPendingInteraction: thread.hasPendingInteraction,
      updatedAt: thread.updatedAt,
    }))
    .sort(
      (a, b) =>
        Number(isActive(b.status)) - Number(isActive(a.status)) || b.updatedAt - a.updatedAt,
    );
}

/** At most this many cards; the header counts every file. */
export const DRIVE_CARDS_MAX = 12;
/**
 * The walk reads at most this many entries, files and folders alike, then
 * stops and reports itself truncated, so a Drive full of files stays cheap.
 */
export const DRIVE_WALK_MAX = 2_000;
const TEXT_FILE = /\.(md|markdown|mdx|txt)$/iu;

export type DriveListing = {
  total: number;
  /** The walk stopped at its bound: `total` and recency cover only what it read. */
  truncated: boolean;
  files: DriveFileItem[];
  folder: { hostId: string; path: string } | null;
};

/** The Drive's files, top-level rules and notes first, then the most recently changed. */
export async function driveFiles(
  deps: CommandDeps,
  primaryHost: () => Promise<string | null>,
  captainId: string,
): Promise<DriveListing> {
  const dir = await validDriveDir(deps, captainId);
  const real = dir === null ? null : realDriveDir(dir);
  if (dir === null || real === null) {
    deps.registry.setServedDrive(captainId, NO_DRIVE);
    return { total: 0, truncated: false, files: [], folder: null };
  }
  const { files: listed, truncated, signature } = listDrive(real);
  deps.registry.setServedDrive(captainId, signature);
  const pinned = DRIVE_FILES.flatMap((name) => listed.filter((file) => file.path === name));
  const rest = listed
    .filter((file) => !pinned.includes(file))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  const files = [...pinned, ...rest]
    .slice(0, DRIVE_CARDS_MAX)
    .map(({ path, name, folder, modifiedAt }): DriveFileItem => ({
      path,
      name,
      folder,
      modifiedAt,
      excerpt: TEXT_FILE.test(name)
        ? readInside(real, drivePathOf(real, path), DRIVE_EXCERPT_BYTES)
        : null,
    }));
  const hostId = await primaryHost();
  return {
    total: listed.length,
    truncated,
    files,
    folder: hostId === null ? null : { hostId, path: dir },
  };
}

/**
 * The Captain's Drive folder, when it is a real folder inside the storage
 * root: not a symlink, and resolving inside the root. Anything else, such as
 * a Drive replaced by a link out of thread storage, reads as no Drive.
 */
export async function validDriveDir(deps: CommandDeps, captainId: string): Promise<string | null> {
  const root = await ensureStorageRoot(deps);
  const dir = root === null ? null : deps.registry.driveDir(captainId);
  if (root === null || dir === null) return null;
  try {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) return null;
    return isInside(realpathSync(root), realpathSync(dir)) ? dir : null;
  } catch {
    return null;
  }
}

/** A Drive folder's real path, or null when it is gone, unreadable or a symlink. */
function realDriveDir(dir: string): string | null {
  try {
    if (lstatSync(dir).isSymbolicLink()) return null;
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/** The bb server's machine, where every Drive lives: read once, again after a failure. */
export function createPrimaryHost(deps: Pick<CommandDeps, "bb">): () => Promise<string | null> {
  let hostId: Promise<string | null> | null = null;
  return () => {
    hostId ??= deps.bb.sdk.system.config().then(
      (config) => config.primaryHostId,
      () => {
        hostId = null;
        return null;
      },
    );
    return hostId;
  };
}

type Listed = Omit<DriveFileItem, "excerpt">;

/** The signature of a Drive that is missing or not a real folder in thread storage. */
const NO_DRIVE = "";

/**
 * The Drive's regular files, breadth first so top-level files are read before
 * deep folders. Dot entries are skipped (temp writes among them), and so is
 * every symlink, file or folder: a link can point out of the Drive or loop. An
 * unreadable folder is skipped, not the whole Drive. Entries are read one at a
 * time, so the bound holds even inside one huge folder.
 *
 * `signature` digests each file's path, mtime, size and inode, and whether the
 * walk stopped at its bound: a scan compares it to tell whether anything a
 * card or count shows has changed, without reading any file.
 *
 * Folders are opened by path, each checked to resolve inside the Drive first.
 * A folder swapped for a link between that check and the open can still be
 * listed; the listing exposes only names and times, under the validated root,
 * so that race is accepted. File contents are read through `readInside`,
 * which binds its checks to the descriptor it reads.
 */
export function listDrive(dir: string): { files: Listed[]; truncated: boolean; signature: string } {
  const root = realDriveDir(dir);
  if (root === null) return { files: [], truncated: false, signature: NO_DRIVE };
  const walk: Walk = {
    dir: root,
    files: [],
    folders: [""],
    budget: DRIVE_WALK_MAX,
    hash: createHash("sha1"),
  };
  let truncated = false;
  for (let next = walk.folders.shift(); next !== undefined; next = walk.folders.shift()) {
    if (!readFolder(walk, next)) {
      truncated = true;
      break;
    }
  }
  walk.hash.update(truncated ? "+" : ".");
  return { files: walk.files, truncated, signature: walk.hash.digest("base64url") };
}

type Walk = { dir: string; files: Listed[]; folders: string[]; budget: number; hash: Hash };

const drivePathOf = (dir: string, path: string) =>
  path === "" ? dir : join(dir, ...path.split("/"));

/** Whether a path resolves inside the Drive, or is the Drive itself. */
function inDrive(root: string, path: string): boolean {
  try {
    const real = realpathSync(path);
    return real === root || isInside(root, real);
  } catch {
    return false;
  }
}

/** Reads one folder's entries into the walk; false once the walk's budget is spent. */
function readFolder(walk: Walk, folder: string): boolean {
  const path = drivePathOf(walk.dir, folder);
  let handle;
  try {
    if (!inDrive(walk.dir, path)) return true;
    handle = opendirSync(path);
  } catch {
    return true;
  }
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (walk.budget === 0) return false;
      walk.budget -= 1;
      if (!entry.name.startsWith(".")) addEntry(walk, folder, entry);
    }
  } catch {
    // A folder that fails mid-read keeps what it gave.
  } finally {
    handle.closeSync();
  }
  return true;
}

function addEntry(walk: Walk, folder: string, entry: Dirent): void {
  const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
  // Dirent types are the entry's own, never a link's target.
  if (entry.isDirectory()) {
    walk.folders.push(path);
    return;
  }
  if (!entry.isFile()) return;
  const stat = lstatSync(drivePathOf(walk.dir, path), { throwIfNoEntry: false });
  if (stat?.isFile() !== true) return;
  walk.hash.update(`${path}\0${stat.mtimeMs}\0${stat.size}\0${stat.ino}\n`);
  walk.files.push({
    path,
    name: entry.name,
    folder: folder === "" ? null : folder,
    modifiedAt: stat.mtimeMs,
  });
}

/** The Drive's signature as a scan sees it now; `NO_DRIVE` when it is missing or not valid. */
export async function driveSignature(deps: CommandDeps, captainId: string): Promise<string> {
  const dir = await validDriveDir(deps, captainId);
  return dir === null ? NO_DRIVE : listDrive(dir).signature;
}

/** How often a watched Drive is scanned for changes. */
const DRIVE_SCAN_MS = 5_000;

/**
 * Refresh a watched Drive read when what it shows has changed: every
 * `scanMs`, compare the Drive's signature with the one the last read served,
 * and refresh when they differ. Nothing is pushed before a read has served
 * one. A CLI write refreshes at once by itself; the read it causes records
 * the new signature, so the next scan finds nothing to push. Resolves once
 * `signal` aborts, which is when the last subscriber leaves.
 */
export async function watchDrive(options: {
  scan: () => Promise<string>;
  served: () => string | undefined;
  signal: AbortSignal;
  onChange: () => void;
  /** Tests scan sooner. */
  scanMs?: number;
}): Promise<void> {
  const { scan, served, signal, onChange } = options;
  const scanMs = options.scanMs ?? DRIVE_SCAN_MS;
  while (!signal.aborted) {
    await sleep(scanMs, signal);
    if (signal.aborted) return;
    const now = await scan().catch(() => null);
    const last = served();
    if (now !== null && last !== undefined && now !== last) onChange();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
