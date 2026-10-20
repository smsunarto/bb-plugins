import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchEvent,
  ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import type { gitbutlerHostSignals } from "../shared/host-contract.ts";
import { createMemo } from "../shared/memo.ts";

/*
 * What the host knows about its repositories between calls, and which ones
 * a panel is looking at. One module owns both, because each makes the other
 * stale: a write or a change seen on disk drops every remembered answer.
 *
 * A board read is a panel's interest. It keeps the repository's Git
 * directory watched for LEASE_MS, and the open panel's next read renews it.
 * When a watched repository changes, the host says so once, and every panel
 * showing it reads it again instead of polling.
 *
 * Reading writes too: `git status` refreshes the index and `but` keeps its
 * own database. Those writes, by the host's own processes, are never a
 * change, or a panel's read would wake it to read again. A write of ours
 * says so itself, through {@link changed}.
 */

/** How long discovery and checkout identity are handed out again. */
const MEMO_MS = 3_000;
/** How long one read keeps its repository watched. Longer than the panel's safety poll. */
export const LEASE_MS = 150_000;

const remembered = createMemo({ ttlMs: MEMO_MS, maxEntries: 2_048 });
const running = createMemo({ ttlMs: 0 });

/** A read whose answer later callers share for a few seconds. */
export function remember<T>(
  key: string,
  signal: AbortSignal,
  load: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return remembered.read(key, load, signal);
}

/** A read that callers asking while it runs share, and nobody after. */
export function share<T>(
  key: string,
  signal: AbortSignal,
  load: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return running.read(key, load, signal);
}

/** Something changed the repositories: nothing read before now is handed out again. */
export function forget(): void {
  remembered.clear();
  running.clear();
}

type Signals = typeof gitbutlerHostSignals;
type WatchContext = Pick<
  ExperimentalHostRpcContext<Signals>,
  "experimental_watch" | "experimental_emitSignal"
>;

/**
 * Git's own churn, which never changes what a board shows: objects arrive
 * before the ref that names them, and reflogs after it.
 */
const IGNORED = ["objects", "logs", "lfs", "hooks", "rr-cache", "modules", "worktrees/*/logs"];
/** A burst of writes, such as a rebase, is one change. */
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 3_000;
const MAX_REF_DIRECTORIES = 4_096;

/** Each key is a path's state. Shared keys are bare; a checkout's own are `path\0name`. */
type Snapshot = Map<string, string>;

type Watch = {
  subscription: Promise<ExperimentalHostWatchSubscription>;
  /** The checkouts being looked at: their Git directory and when their lease ends. */
  viewers: Map<string, { gitDir: string; until: number }>;
  seen: Snapshot;
  /** Checks run one at a time, so an event never compares against half a baseline. */
  queue: Promise<void>;
  /** A queued, not yet started, taking of our own processes' writes as seen. */
  absorbing: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const watches = new Map<string, Watch>();

/**
 * Written by reads as well as writes: `git status` refreshes the index and
 * `but` keeps its own database. What our own processes write here is taken
 * as the new baseline, so it never wakes the panels that asked for it.
 */
function volatile(key: string): boolean {
  return key.endsWith("\0index") || key.startsWith(`gitbutler${sep}`);
}

/**
 * Where our own `git` and `but` processes run, by working directory. One
 * stays here after it exits until its writes are taken as seen, so an event
 * they cause always finds it.
 */
const ours = new Map<string, number>();
const realPaths = new Map<string, Promise<string | null>>();

function realPathOf(cwd: string): Promise<string | null> {
  let found = realPaths.get(cwd);
  if (!found) {
    if (realPaths.size >= 2_048) realPaths.clear();
    found = realpath(cwd).catch(() => null);
    realPaths.set(cwd, found);
  }
  return found;
}

function viewerAt(watch: Watch, path: string): string | null {
  for (const viewer of watch.viewers.keys()) {
    if (path === viewer || path.startsWith(`${viewer}${sep}`)) return viewer;
  }
  return null;
}

/** The viewed checkouts one of our processes runs in, or has not yet settled. */
async function busyViewers(watch: Watch): Promise<Set<string>> {
  const paths = await Promise.all([...ours.keys()].map(realPathOf));
  const busy = new Set<string>();
  for (const path of paths) {
    const viewer = path === null ? null : viewerAt(watch, path);
    if (viewer !== null) busy.add(viewer);
  }
  return busy;
}

/**
 * Marks a `git` or `but` process of ours running in `cwd`. The returned
 * function, called once it exits, takes what it wrote as seen.
 */
export function ownProcess(cwd: string): () => Promise<void> {
  ours.set(cwd, (ours.get(cwd) ?? 0) + 1);
  return async () => {
    try {
      const path = await realPathOf(cwd);
      if (path === null) return;
      const settling: Promise<void>[] = [];
      for (const [commonDir, watch] of watches) {
        if (viewerAt(watch, path) !== null) settling.push(absorb(commonDir, watch));
      }
      await Promise.all(settling);
    } finally {
      const left = (ours.get(cwd) ?? 1) - 1;
      if (left > 0) ours.set(cwd, left);
      else ours.delete(cwd);
    }
  };
}

/** Takes the volatile files as they are now as seen. Queued calls share one look. */
function absorb(commonDir: string, watch: Watch): Promise<void> {
  watch.absorbing ??= enqueue(watch, async () => {
    watch.absorbing = null;
    // A watch with no baseline yet takes everything from the read that armed it.
    if (watch.seen.size === 0) return;
    for (const [key, value] of await volatileFiles(commonDir, watch.viewers)) {
      watch.seen.set(key, value);
    }
  });
  return watch.absorbing;
}

async function fileState(path: string): Promise<string> {
  try {
    const found = await stat(path);
    return `${found.mtimeMs}:${found.size}:${found.ino}`;
  } catch {
    return "-";
  }
}

/** Every directory under refs/, by mtime: Git renames each ref into place, which touches its directory. */
async function refDirectories(commonDir: string, into: Snapshot): Promise<void> {
  const pending = [join(commonDir, "refs")];
  let seen = 0;
  while (pending.length > 0 && seen < MAX_REF_DIRECTORIES) {
    const directory = pending.pop()!;
    seen += 1;
    into.set(relative(commonDir, directory), await fileState(directory));
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
}

/** The {@link volatile} files alone: what reads write. */
async function volatileFiles(
  commonDir: string,
  viewers: Watch["viewers"],
  state: Snapshot = new Map(),
): Promise<Snapshot> {
  const gitbutler = join(commonDir, "gitbutler");
  for (const name of await readdir(gitbutler).catch(() => [])) {
    // SQLite readers write the -shm index, and lock files come and go.
    if (name.endsWith("-shm") || name.endsWith(".lock")) continue;
    state.set(join("gitbutler", name), await fileState(join(gitbutler, name)));
  }
  for (const [path, { gitDir }] of viewers) {
    state.set(`${path}\0index`, await fileState(join(gitDir, "index")));
  }
  return state;
}

async function snapshot(commonDir: string, viewers: Watch["viewers"]): Promise<Snapshot> {
  const state: Snapshot = new Map();
  await refDirectories(commonDir, state);
  for (const name of ["packed-refs", "FETCH_HEAD", join("reftable", "tables.list")]) {
    state.set(name, await fileState(join(commonDir, name)));
  }
  for (const [path, { gitDir }] of viewers) {
    const head = await readFile(join(gitDir, "HEAD"), "utf8").catch(() => "-");
    state.set(`${path}\0HEAD`, head.trim());
  }
  return volatileFiles(commonDir, viewers, state);
}

/** A checkout's own Git directory: `.git`, or where a linked worktree's `.git` file points. */
async function gitDirOf(path: string): Promise<string> {
  const dotGit = join(path, ".git");
  if ((await stat(dotGit)).isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
  if (!pointer) throw new Error(`${dotGit} names no Git directory.`);
  return resolve(path, pointer);
}

function enqueue(watch: Watch, task: () => Promise<void>): Promise<void> {
  watch.queue = watch.queue.then(task).catch(() => undefined);
  return watch.queue;
}

function stop(commonDir: string, watch: Watch): void {
  if (watches.get(commonDir) !== watch) return;
  watches.delete(commonDir);
  if (watch.timer) clearTimeout(watch.timer);
  void watch.subscription.then((subscription) => subscription.dispose()).catch(() => undefined);
}

/** Drops the viewers whose lease ran out, and the watch with the last of them. */
function expire(commonDir: string, watch: Watch, now = Date.now()): void {
  for (const [path, viewer] of watch.viewers) {
    if (viewer.until <= now) watch.viewers.delete(path);
  }
  if (watch.viewers.size === 0) return stop(commonDir, watch);
  const next = Math.min(...[...watch.viewers.values()].map((viewer) => viewer.until));
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = setTimeout(() => expire(commonDir, watch), Math.max(0, next - now));
  watch.timer.unref?.();
}

/** Compares the repository with the last baseline, and names the viewed checkouts it changed. */
async function check(commonDir: string, watch: Watch, context: WatchContext): Promise<void> {
  const now = await snapshot(commonDir, watch.viewers);
  const busy = await busyViewers(watch);
  const touched = new Set<string>();
  let shared = false;
  for (const [key, value] of now) {
    if (watch.seen.get(key) === value) continue;
    const owner = key.split("\0");
    // Our own process wrote it: the baseline takes it below.
    if (volatile(key) && (owner.length === 2 ? busy.has(owner[0]!) : busy.size > 0)) continue;
    // A checkout first seen here is a viewer whose own read has not yet taken its baseline.
    if (owner.length === 2 && watch.seen.has(key)) touched.add(owner[0]!);
    else if (owner.length !== 2) shared = true;
  }
  watch.seen = now;
  const checkouts = shared ? [...watch.viewers.keys()] : [...touched];
  if (checkouts.length === 0) return;
  forget();
  await context.experimental_emitSignal("repositoryChanged", { commonDir, checkouts });
}

/**
 * A write of ours changed `commonDir`. Its processes' writes are never a
 * change on their own, so it tells every panel showing the repository here.
 */
export function changed(commonDir: string, context: WatchContext): Promise<void> {
  const watch = watches.get(commonDir);
  if (!watch) return Promise.resolve();
  return enqueue(watch, async () => {
    watch.seen = await snapshot(commonDir, watch.viewers);
    const checkouts = [...watch.viewers.keys()];
    if (checkouts.length === 0) return;
    forget();
    await context.experimental_emitSignal("repositoryChanged", { commonDir, checkouts });
  });
}

function listen(commonDir: string, watch: Watch, context: WatchContext) {
  return (event: ExperimentalHostWatchEvent) => {
    if (watches.get(commonDir) !== watch) return;
    // A broken watch goes, and the next read arms a new one.
    if (event.kind === "watch-error") return stop(commonDir, watch);
    // A rescan means events were dropped, which the snapshot does not need.
    return enqueue(watch, () => check(commonDir, watch, context));
  };
}

/**
 * Keeps `checkout`'s repository watched for LEASE_MS more, and takes what
 * the read that just ended may have written as already seen. A watch that
 * cannot start leaves the board as it is: the panel's poll still reads it.
 */
export async function keepWatching(
  checkout: { path: string; commonDir: string },
  context: WatchContext,
): Promise<void> {
  const { path, commonDir } = checkout;
  let watch = watches.get(commonDir);
  if (!watch) {
    const created: Watch = {
      subscription: Promise.resolve({ dispose: async () => undefined }),
      viewers: new Map(),
      seen: new Map(),
      queue: Promise.resolve(),
      absorbing: null,
      timer: null,
    };
    watches.set(commonDir, created);
    try {
      created.subscription = context.experimental_watch(
        {
          rootPath: commonDir,
          ignoredPaths: IGNORED,
          debounceMs: DEBOUNCE_MS,
          maxWaitMs: MAX_WAIT_MS,
        },
        listen(commonDir, created, context),
      );
    } catch (error) {
      stop(commonDir, created);
      throw error;
    }
    created.subscription.catch(() => stop(commonDir, created));
    watch = created;
  }
  const current = watch;
  const gitDir = current.viewers.get(path)?.gitDir ?? (await gitDirOf(path).catch(() => null));
  // A watch nobody could be added to goes at once.
  if (gitDir === null) return expire(commonDir, current);
  const known = current.viewers.has(path);
  current.viewers.set(path, { gitDir, until: Date.now() + LEASE_MS });
  expire(commonDir, current);
  await enqueue(current, async () => {
    const now = await snapshot(commonDir, current.viewers);
    // A new watch or viewer starts from what is there now. An old one only
    // takes what reads write, so a ref that moved during the read still wakes it.
    const fresh = current.seen.size === 0;
    for (const [key, value] of now) {
      const own = key.startsWith(`${path}\0`);
      if (fresh || volatile(key) || (own && !known)) current.seen.set(key, value);
    }
  });
}
