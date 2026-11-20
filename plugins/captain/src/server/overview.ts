import {
  type Dirent,
  type FSWatcher,
  type Stats,
  lstatSync,
  opendirSync,
  realpathSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { DRIVE_EXCERPT_BYTES, type CrewThreadItem, type DriveFileItem } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { ensureStorageRoot } from "./commands/deps.ts";
import { isActive, joinCrew } from "./crew.ts";
import { DRIVE_FILES, isInside } from "./drive.ts";
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
  if (dir === null) return { total: 0, truncated: false, files: [], folder: null };
  const real = realDriveDir(dir);
  if (real === null) return { total: 0, truncated: false, files: [], folder: null };
  const { files: listed, truncated } = listDrive(real);
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
      excerpt: TEXT_FILE.test(name) ? excerpt(deps, real, path) : null,
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

/**
 * The Drive's regular files, breadth first so top-level files are read before
 * deep folders. Dot entries are skipped (temp writes among them), and so is
 * every symlink, file or folder: a link can point out of the Drive or loop. An
 * unreadable folder is skipped, not the whole Drive. Entries are read one at a
 * time, so the bound holds even inside one huge folder.
 */
export function listDrive(dir: string): { files: Listed[]; truncated: boolean } {
  const root = realDriveDir(dir);
  if (root === null) return { files: [], truncated: false };
  const walk: Walk = { dir: root, files: [], folders: [""], budget: DRIVE_WALK_MAX };
  for (let next = walk.folders.shift(); next !== undefined; next = walk.folders.shift()) {
    if (!readFolder(walk, next)) return { files: walk.files, truncated: true };
  }
  return { files: walk.files, truncated: false };
}

type Walk = { dir: string; files: Listed[]; folders: string[]; budget: number };

const drivePathOf = (dir: string, path: string) =>
  path === "" ? dir : join(dir, ...path.split("/"));

/**
 * Whether a path still resolves inside the Drive (the Drive itself for its
 * root), checked as it is opened: a folder or file swapped for a link after
 * the walk saw it is not read.
 */
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
  walk.files.push({
    path,
    name: entry.name,
    folder: folder === "" ? null : folder,
    modifiedAt: stat.mtimeMs,
  });
}

/**
 * A file's head, at most the excerpt cap, however much of it the Drive cache
 * holds; null for a file that is no longer a regular file inside the Drive.
 */
function excerpt(deps: Pick<CommandDeps, "drive">, root: string, file: string): string | null {
  const path = drivePathOf(root, file);
  try {
    if (!lstatSync(path).isFile() || !isInside(root, realpathSync(path))) return null;
    return deps.drive.head(path, DRIVE_EXCERPT_BYTES);
  } catch {
    return null;
  }
}

/** Changes are refreshed at most this often: a write is a temp file and a rename. */
const DRIVE_SETTLE_MS = 300;
/** How long a watch that could not start, or died, waits before it starts again. */
const DRIVE_WATCH_RETRY_MS = 5_000;

/**
 * Refresh a watched Drive read when a file in it changes, through the
 * filesystem's own notifications rather than polling. A watch that cannot
 * start (no storage root or no folder yet), errors, or loses its folder (the
 * folder deleted or replaced) starts again after a pause, and refreshes once
 * it does, for what changed meanwhile. Changes refresh at most once per
 * settle window, and keep refreshing through a steady stream of writes.
 * `onLive` reports whether a watch is running, so a CLI write refreshes only
 * when none is. Resolves once `signal` aborts.
 */
export async function watchDrive(options: {
  resolveDir: () => Promise<string | null>;
  signal: AbortSignal;
  onChange: () => void;
  onLive: (live: boolean) => void;
  warn: (line: string) => void;
  /** Tests shorten the pauses. */
  retryMs?: number;
  settleMs?: number;
}): Promise<void> {
  const { resolveDir, signal, onChange, onLive, warn } = options;
  const timing = {
    retryMs: options.retryMs ?? DRIVE_WATCH_RETRY_MS,
    settleMs: options.settleMs ?? DRIVE_SETTLE_MS,
  };
  for (let attempt = 0; !signal.aborted; attempt += 1) {
    const dir = await resolveDir().catch(() => null);
    if (dir !== null && !signal.aborted) {
      // After a failed or ended attempt, the read may be stale: refresh once started.
      await watchOnce(dir, signal, { onChange, onLive, warn }, attempt > 0, timing.settleMs);
    }
    if (signal.aborted) return;
    await sleep(timing.retryMs, signal);
  }
}

/** A watch covers at most this many of the Drive's folders, the shallowest first. */
const DRIVE_WATCH_FOLDERS_MAX = 256;

type WatchHooks = Pick<Parameters<typeof watchDrive>[0], "onChange" | "onLive" | "warn">;

/**
 * One watch of one Drive; resolves when it ends, or at once if it cannot
 * start. Each folder gets its own plain watcher rather than one recursive
 * watch: Node's recursive watch on Linux stats every changed entry inside its
 * own event handler, where a permission error escapes as an uncaught
 * exception. The folder set is read again after each refresh, so a new folder
 * is watched from then on.
 */
function watchOnce(
  dir: string,
  signal: AbortSignal,
  { onChange, onLive, warn }: WatchHooks,
  catchUp: boolean,
  settleMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const folder = folderStat(dir);
    if (folder === null) return resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const watchers = new Map<string, FSWatcher>();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", end);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      onLive(false);
      resolve();
    };
    const changed = () => {
      timer ??= setTimeout(fire, settleMs);
    };
    /** Watch every folder the Drive has now, and stop watching the ones gone. */
    const sync = () => {
      const folders = new Set(driveFolders(dir));
      for (const [path, watcher] of watchers) {
        if (path !== "" && !folders.has(path)) {
          watcher.close();
          watchers.delete(path);
        }
      }
      for (const path of folders) {
        if (!watchers.has(path)) watchFolder(path);
      }
    };
    const watchFolder = (path: string) => {
      let watcher: FSWatcher;
      try {
        watcher = watch(drivePathOf(dir, path), changed);
      } catch (error) {
        // The Drive's own folder must be watched; a subfolder may have just gone.
        if (path === "" && (error as NodeJS.ErrnoException).code !== "ENOENT") {
          warn(`drive watch for ${dir}: ${(error as Error).message}`);
        }
        if (path === "") end();
        return;
      }
      watchers.set(path, watcher);
      watcher.on("error", (error) => {
        if (path === "") {
          warn(`drive watch for ${dir}: ${error.message}; restarting`);
          end();
          return;
        }
        watcher.close();
        watchers.delete(path);
        changed();
      });
      if (path === "") watcher.on("close", end);
    };
    const fire = () => {
      timer = null;
      const now = folderStat(dir);
      // The folder went, was replaced or can no longer be reached: this watch
      // sees nothing of what follows, so it ends and the next one catches up.
      if (now === null || now.ino !== folder.ino) {
        onChange();
        end();
        return;
      }
      onChange();
      sync();
    };
    watchFolder("");
    if (ended) return;
    sync();
    signal.addEventListener("abort", end, { once: true });
    onLive(true);
    // A restarted watch missed what changed while it was down.
    if (catchUp) onChange();
  });
}

/**
 * The Drive's folders, the Drive itself first then breadth first, with the
 * walk's own skips: dot folders and symlinks. Bounded in folders kept and in
 * entries read, so a huge Drive costs no more to watch than to list.
 */
function driveFolders(dir: string): string[] {
  const folders = [""];
  let budget = DRIVE_WALK_MAX;
  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index] ?? "";
    let handle;
    try {
      handle = opendirSync(drivePathOf(dir, folder));
    } catch {
      continue;
    }
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (budget === 0 || folders.length >= DRIVE_WATCH_FOLDERS_MAX) return folders;
        budget -= 1;
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          folders.push(folder === "" ? entry.name : `${folder}/${entry.name}`);
        }
      }
    } catch {
      // A folder that fails mid-read keeps what it gave.
    } finally {
      handle.closeSync();
    }
  }
  return folders;
}

/** The folder's own stat when it is a folder, not a link; null when missing or unreachable. */
function folderStat(dir: string): Stats | null {
  try {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    return stat?.isDirectory() === true ? stat : null;
  } catch {
    // EACCES on a parent, say: as missing, so the watch retries.
    return null;
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
