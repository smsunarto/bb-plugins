import { createHash, type Hash } from "node:crypto";
import { type Dirent, lstatSync, opendirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type CaptainTaskItem,
  type CREW_STATES,
  DRIVE_EXCERPT_BYTES,
  type DriveFileItem,
} from "../contract/rpc.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { ensureStorageRoot } from "./commands/deps.ts";
import { type CrewThread, isActive, joinCrew } from "./crew.ts";
import { DRIVE_FILES, isInside, readInside } from "./drive.ts";
import type { CrewSnapshot } from "./queue.ts";
import { ROLE_SPECS, SHIP_READY_REVIEWS } from "./roles.ts";
import type { TasksTask } from "./tasks-client.ts";

/**
 * The Overview tab's reads: the Captain's tasks as rows, and its Drive as
 * cards. Asks come from the banner's own `asks` read.
 */

/** Each repo's open tasks are read up to this many; past it the count is a floor. */
export const TASKS_PER_REPO = 100;

/** Rank in the Tasks section: what waits on the user first, then work under way. */
const RANK: Record<string, number> = { in_review: 1, in_progress: 2, todo: 3, backlog: 4 };
const rankOf = (task: CaptainTaskItem) => (task.ready ? 0 : (RANK[task.status] ?? 5));

/**
 * The Captain's repos' open tasks (done and canceled left out), with the
 * crew thread on each. Ready to ship, then in review, in progress, todo and
 * backlog; the most recently updated first within each. A Tasks failure
 * fails the read; a crew failure keeps the tasks without their crew.
 */
export async function captainTasks(
  deps: Pick<CommandDeps, "registry" | "store" | "tasks">,
  readCrew: (captainId: string) => CrewSnapshot,
  captainId: string,
): Promise<{ tasks: CaptainTaskItem[]; truncated: boolean; crewError: string | null }> {
  const crewRead = readCrew(captainId);
  // The crew is read while Tasks answers; its failure is labelled, not fatal.
  const crew = Promise.all([crewRead.threads, crewRead.rows]).then(
    ([threads, rows]) => ({ crew: joinCrew(deps, threads, rows), error: null }),
    (error: unknown) => ({ crew: [] as CrewThread[], error: (error as Error).message }),
  );
  const lists = await readOpenTasks(deps, captainId);
  const open = lists.flat();
  const [fields, joined] = await Promise.all([
    deps.tasks.fieldsOf(open.map((task) => task.id)),
    crew,
  ]);
  const crewOf = crewByTask(joined.crew);
  const tasks = open
    .map((task): CaptainTaskItem => ({
      key: task.key,
      title: task.title,
      status: task.status,
      ready: (fields.get(task.id) ?? []).some(
        (field) => field.key === "review" && SHIP_READY_REVIEWS.has(field.value),
      ),
      crew: crewOf.get(task.key) ?? null,
      updatedAt: Date.parse(task.updatedAt) || 0,
    }))
    .sort((a, b) => rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt);
  return {
    tasks,
    truncated: lists.some((list) => list.length >= TASKS_PER_REPO),
    crewError: joined.error,
  };
}

/** Each of the Captain's repos' open tasks, at most `TASKS_PER_REPO` each; a repo with no Tasks project reads none. */
async function readOpenTasks(
  deps: Pick<CommandDeps, "registry" | "tasks">,
  captainId: string,
): Promise<TasksTask[][]> {
  const captain = deps.registry.get(captainId);
  const projects = await deps.tasks.listProjects();
  const byPrefix = new Map(projects.map((project) => [project.prefix, project]));
  return Promise.all(
    (captain?.repos ?? []).map((repo) => {
      const project = byPrefix.get(repo.tasksProjectKey);
      return project === undefined
        ? Promise.resolve([])
        : deps.tasks.listOpenTasks(project.id, TASKS_PER_REPO);
    }),
  );
}

/**
 * What the Tasks rows show from Tasks alone, as one string: a change made
 * outside the crew, such as in Tasks itself, changes it. A review verdict
 * moves the task's `updatedAt`, so it counts too.
 */
export async function openTasksSignature(
  deps: Pick<CommandDeps, "registry" | "tasks">,
  captainId: string,
): Promise<string> {
  return (await readOpenTasks(deps, captainId))
    .flat()
    .map((task) => `${task.key}\0${task.status}\0${task.title}\0${task.updatedAt}`)
    .join("\n");
}

/** Each task's crew thread: a busy one before an idle one, then the latest attached. */
function crewByTask(
  crew: readonly CrewThread[],
): Map<string, NonNullable<CaptainTaskItem["crew"]>> {
  const best = new Map<string, { member: CrewThread; attachedAt: string }>();
  for (const member of crew) {
    for (const row of member.rows) {
      const current = best.get(row.task.key);
      const busier =
        current === undefined
          ? 1
          : Number(isActive(member.thread.status)) - Number(isActive(current.member.thread.status));
      if (
        busier > 0 ||
        (busier === 0 && current !== undefined && row.attachedAt > current.attachedAt)
      ) {
        best.set(row.task.key, { member, attachedAt: row.attachedAt });
      }
    }
  }
  return new Map(
    [...best].map(([key, { member }]) => [
      key,
      {
        threadId: member.thread.id,
        role: member.role === null ? null : ROLE_SPECS[member.role].label,
        state: crewState(member.thread),
      },
    ]),
  );
}

function crewState(thread: {
  status: string;
  hasPendingInteraction: boolean;
}): (typeof CREW_STATES)[number] {
  if (thread.status === "error") return "errored";
  if (thread.hasPendingInteraction) return "needs-input";
  return isActive(thread.status) ? "working" : "idle";
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
  if (dir === null || real === null) return { total: 0, truncated: false, files: [], folder: null };
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
 * Refresh a watched Drive read when what it shows has changed. A scan at the
 * start sets the baseline; then every `scanMs` the Drive's signature is
 * compared with it, and a difference becomes the new baseline and a refresh
 * to every watcher. Only such a refresh moves the baseline: one client's own
 * read never does, or an edit it saw would be hidden from the rest. A CLI
 * write refreshes at once and sets the baseline itself (see `drive write`).
 * A scan that settles after `signal` aborts publishes nothing. Resolves once
 * `signal` aborts, which is when the last subscriber leaves.
 */
export async function watchDrive(options: {
  scan: () => Promise<string>;
  baseline: () => string | undefined;
  setBaseline: (signature: string | null) => void;
  signal: AbortSignal;
  onChange: () => void;
  /** Tests scan sooner. */
  scanMs?: number;
}): Promise<void> {
  const { scan, baseline, setBaseline, signal, onChange } = options;
  const scanMs = options.scanMs ?? DRIVE_SCAN_MS;
  const first = await scan().catch(() => null);
  if (signal.aborted) return;
  if (first !== null) setBaseline(first);
  try {
    while (!signal.aborted) {
      await sleep(scanMs, signal);
      if (signal.aborted) return;
      const now = await scan().catch(() => null);
      if (signal.aborted || now === null || now === baseline()) continue;
      setBaseline(now);
      onChange();
    }
  } finally {
    setBaseline(null);
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
