import { type Dirent, lstatSync, opendirSync, watch } from "node:fs";
import { join } from "node:path";
import { DRIVE_EXCERPT_BYTES, type CrewThreadItem, type DriveFileItem } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { ensureStorageRoot } from "./commands/deps.ts";
import { isActive, joinCrew } from "./crew.ts";
import { DRIVE_FILES } from "./drive.ts";
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
  readCrew: (captainId: string) => Promise<CrewSnapshot>,
  modelName: ModelNames,
  captainId: string,
): Promise<CrewThreadItem[]> {
  const { threads, rows } = await readCrew(captainId);
  const signal = AbortSignal.timeout(READ_DEADLINE_MS);
  const models = await Promise.all(threads.map((thread) => modelName(thread, signal)));
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
  const root = await ensureStorageRoot(deps);
  const dir = root === null ? null : deps.registry.driveDir(captainId);
  if (dir === null) return { total: 0, truncated: false, files: [], folder: null };
  const { files: listed, truncated } = listDrive(dir);
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
      excerpt: TEXT_FILE.test(name) ? excerpt(deps, join(dir, ...path.split("/"))) : null,
    }));
  const hostId = await primaryHost();
  return {
    total: listed.length,
    truncated,
    files,
    folder: hostId === null ? null : { hostId, path: dir },
  };
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
  const walk: Walk = { dir, files: [], folders: [""], budget: DRIVE_WALK_MAX };
  for (let next = walk.folders.shift(); next !== undefined; next = walk.folders.shift()) {
    if (!readFolder(walk, next)) return { files: walk.files, truncated: true };
  }
  return { files: walk.files, truncated: false };
}

type Walk = { dir: string; files: Listed[]; folders: string[]; budget: number };

const drivePathOf = (dir: string, path: string) =>
  path === "" ? dir : join(dir, ...path.split("/"));

/** Reads one folder's entries into the walk; false once the walk's budget is spent. */
function readFolder(walk: Walk, folder: string): boolean {
  let handle;
  try {
    handle = opendirSync(drivePathOf(walk.dir, folder));
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

/** A file's head, at most the excerpt cap, however much of it the Drive cache holds. */
function excerpt(deps: Pick<CommandDeps, "drive">, path: string): string | null {
  try {
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

/** One watch of one folder; resolves when it ends, or at once if it cannot start. */
function watchOnce(
  dir: string,
  signal: AbortSignal,
  {
    onChange,
    onLive,
    warn,
  }: Pick<Parameters<typeof watchDrive>[0], "onChange" | "onLive" | "warn">,
  catchUp: boolean,
  settleMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const folder = lstatSync(dir, { throwIfNoEntry: false });
    if (folder === undefined || !folder.isDirectory()) return resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: ReturnType<typeof watch> | null = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", end);
      watcher?.close();
      onLive(false);
      resolve();
    };
    const fire = () => {
      timer = null;
      const now = lstatSync(dir, { throwIfNoEntry: false });
      // The folder went or was replaced: this watch sees nothing of the new one.
      if (now === undefined || now.ino !== folder.ino) {
        onChange();
        end();
        return;
      }
      onChange();
    };
    try {
      watcher = watch(dir, { recursive: true }, () => {
        timer ??= setTimeout(fire, settleMs);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`drive watch for ${dir}: ${(error as Error).message}`);
      }
      return resolve();
    }
    watcher.on("error", (error) => {
      warn(`drive watch for ${dir}: ${error.message}; restarting`);
      end();
    });
    watcher.on("close", end);
    signal.addEventListener("abort", end, { once: true });
    onLive(true);
    // A restarted watch missed what changed while it was down.
    if (catchUp) onChange();
  });
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
