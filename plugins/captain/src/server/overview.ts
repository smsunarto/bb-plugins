import { readdirSync, statSync, watch, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CrewThreadItem, DriveFileItem } from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { ensureStorageRoot } from "./commands/deps.ts";
import { joinCrew, listChildren } from "./crew.ts";
import { DRIVE_FILES } from "./drive.ts";
import { TasksError, type CrewRow } from "./tasks-client.ts";

/**
 * The Overview tab's reads: the Captain's crew as rows, and its Drive as
 * cards. Asks come from the banner's own `asks` read.
 */

/** bb's own reads for the tab; a hung read must not hold it. */
const READ_DEADLINE_MS = 8_000;
/** How long a provider's model names are reused before they are read again. */
const MODEL_NAMES_TTL_MS = 10 * 60_000;

/**
 * Each crew thread's model, and each provider's model display names. A thread
 * keeps its model for life (a fallback restarts on a new thread), so its model
 * is read once; a provider's catalog is read at most once per TTL.
 */
export function createModelNames(deps: Pick<CommandDeps, "bb">, now: () => number = Date.now) {
  const threadModels = new Map<string, string | null>();
  const catalogs = new Map<string, { at: number; names: Promise<Map<string, string>> }>();

  function catalog(providerId: string): Promise<Map<string, string>> {
    const cached = catalogs.get(providerId);
    if (cached !== undefined && now() - cached.at < MODEL_NAMES_TTL_MS) return cached.names;
    const names = deps.bb.sdk.providers
      .models({ providerId, preferCached: true })
      .then((result) => new Map(result.models.map((model) => [model.model, model.displayName])))
      .catch(() => new Map<string, string>());
    catalogs.set(providerId, { at: now(), names });
    return names;
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
    return (await catalog(thread.providerId)).get(model) ?? model;
  };
}

export type ModelNames = ReturnType<typeof createModelNames>;

/** bb statuses with a turn running or about to run sort first. */
const ACTIVE = new Set(["active", "starting", "pending", "stopping"]);

/**
 * The Captain's unarchived crew: active first, then the most recently
 * updated. A Tasks failure keeps every thread and drops only its task.
 */
export async function crewThreads(
  deps: CommandDeps,
  modelName: ModelNames,
  captainId: string,
): Promise<CrewThreadItem[]> {
  const signal = AbortSignal.timeout(READ_DEADLINE_MS);
  const threads = await listChildren(deps.bb, captainId, false, signal);
  const [rows, models] = await Promise.all([
    threads.length === 0
      ? Promise.resolve([] as CrewRow[])
      : deps.tasks.crewSnapshot(threads.map((thread) => thread.id)).catch((error: unknown) => {
          if (!(error instanceof TasksError)) throw error;
          deps.bb.log.warn(`overview crew read without Tasks: ${error.message}`);
          return [] as CrewRow[];
        }),
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
      role,
      hasPendingInteraction: thread.hasPendingInteraction,
      updatedAt: thread.updatedAt,
    }))
    .sort(
      (a, b) =>
        Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.updatedAt - a.updatedAt,
    );
}

/** At most this many cards; the header counts every file. */
export const DRIVE_CARDS_MAX = 12;
/** A walk stops after this many entries, so a Drive full of files stays cheap to list. */
const DRIVE_WALK_MAX = 2_000;
/** How much of a file a card previews. */
const EXCERPT_BYTES = 1_200;
const TEXT_FILE = /\.(md|markdown|mdx|txt)$/iu;

/** The Drive's files, top-level rules and notes first, then the most recently changed. */
export async function driveFiles(
  deps: CommandDeps,
  primaryHost: () => Promise<string | null>,
  captainId: string,
): Promise<{
  total: number;
  files: DriveFileItem[];
  folder: { hostId: string; path: string } | null;
}> {
  const root = await ensureStorageRoot(deps);
  const dir = root === null ? null : deps.registry.driveDir(captainId);
  if (dir === null) return { total: 0, files: [], folder: null };
  const listed = listDrive(dir);
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

/** Every file under the Drive, skipping dotfiles and dot-folders such as temp writes. */
function listDrive(dir: string): Listed[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const files: Listed[] = [];
  for (const entry of entries.slice(0, DRIVE_WALK_MAX)) {
    if (!entry.isFile()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    const segments = path.split("/");
    if (segments.some((segment) => segment.startsWith("."))) continue;
    const stat = statSync(join(dir, path), { throwIfNoEntry: false });
    if (stat === undefined) continue;
    files.push({
      path,
      name: entry.name,
      folder: segments.length > 1 ? segments.slice(0, -1).join("/") : null,
      modifiedAt: stat.mtimeMs,
    });
  }
  return files;
}

/** A file's head; a character the byte cap cut in two is dropped. */
function excerpt(deps: Pick<CommandDeps, "drive">, path: string): string | null {
  try {
    return deps.drive.read(path, EXCERPT_BYTES)?.replace(/�+$/u, "") ?? null;
  } catch {
    return null;
  }
}

/** How long Drive changes settle before one refresh: a write is a temp file and a rename. */
const DRIVE_SETTLE_MS = 300;

/**
 * Refresh a watched Drive read when a file in it changes, through the
 * filesystem's own notifications rather than polling. Resolves once `signal`
 * aborts. A platform without recursive watching refreshes on CLI writes alone.
 */
export function watchDrive(
  dir: string,
  signal: AbortSignal,
  onChange: () => void,
  warn: (line: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(dir, { recursive: true, signal }, () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          onChange();
        }, DRIVE_SETTLE_MS);
      });
      watcher.on("error", (error) => warn(`drive watch for ${dir}: ${error.message}`));
    } catch (error) {
      // A Drive not written yet has no folder to watch; its first CLI write refreshes it.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`drive watch for ${dir}: ${(error as Error).message}`);
      }
    }
    signal.addEventListener(
      "abort",
      () => {
        if (timer !== null) clearTimeout(timer);
        watcher?.close();
        resolve();
      },
      { once: true },
    );
  });
}
