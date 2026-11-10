/**
 * Which checkouts the server is looking at, and telling it when one changes.
 * Ported from `plugins/gitbutler/src/host/repository-state.ts`, with a
 * second watch on each checkout's working tree.
 *
 * A `workspace` read (or `renewWatch`) is the server's interest. It keeps
 * the checkout watched for WATCH_LEASE_MS, and the next read renews it. Two
 * watches serve it: the repository's shared Git directory (refs, HEAD, the
 * index, GitButler's state), and the checkout's working tree, whose changes
 * count only for files git does not ignore. When either changes, the host
 * says so once with `checkoutChanged`, naming the checkout as the server did.
 *
 * Reading writes too: `git status` can refresh the index and `but` keeps its
 * own database. Those writes, by the host's own processes, are never a
 * change, or a read would wake the server to read again. A write of ours
 * says so itself, through {@link changed}.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchEvent,
  ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import { WATCH_LEASE_MS, type sourceControlHostSignals } from "../contract/host.ts";
import { runGitCommand } from "./cli.ts";
import { forget } from "./memo.ts";

type Signals = typeof sourceControlHostSignals;
type WatchContext = Pick<
  ExperimentalHostRpcContext<Signals>,
  "experimental_watch" | "experimental_emitSignal"
>;

/**
 * Git's own churn, which never changes what a read shows: objects arrive
 * before the ref that names them, and reflogs after it.
 */
const IGNORED = ["objects", "logs", "lfs", "hooks", "rr-cache", "modules", "worktrees/*/logs"];
/** A burst of writes, such as a rebase or a save-all, is one change. */
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 3_000;
const MAX_REF_DIRECTORIES = 4_096;
/** Ignored directories handed to the native watcher, so it never descends into them. */
const MAX_IGNORED_DIRECTORIES = 1_000;
/** Most paths one working-tree event is checked against `git check-ignore` for. */
const MAX_CHECKED_PATHS = 1_000;
const MAX_SIGNAL_PATHS = 1_000;

/** Each key is a path's state. Shared keys are bare; a checkout's own are `name\0file`. */
type Snapshot = Map<string, string>;

/** A checkout being looked at, by the name the server gave it. */
type Viewer = { real: string; gitDir: string; until: number };

type Watch = {
  subscription: Promise<ExperimentalHostWatchSubscription>;
  viewers: Map<string, Viewer>;
  seen: Snapshot;
  /** Checks run one at a time, so an event never compares against half a baseline. */
  queue: Promise<void>;
  /** A queued, not yet started, taking of our own processes' writes as seen. */
  absorbing: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  context: WatchContext;
};

/** One checkout's working tree, shared by every name that reaches it. */
type Tree = {
  subscription: Promise<ExperimentalHostWatchSubscription>;
  queue: Promise<void>;
  context: WatchContext;
};

const watches = new Map<string, Watch>();
const trees = new Map<string, Tree>();

/**
 * Written by reads as well as writes: `git status` refreshes the index and
 * `but` keeps its own database. What our own processes write here is taken
 * as the new baseline, so it never wakes the server that asked for it.
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

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** The viewed checkouts a process in `path` runs in. */
function viewersAt(watch: Watch, path: string): string[] {
  return [...watch.viewers].filter(([, viewer]) => inside(viewer.real, path)).map(([name]) => name);
}

/** The viewed checkouts one of our processes runs in, or has not yet settled. */
async function busyViewers(watch: Watch): Promise<Set<string>> {
  const paths = await Promise.all([...ours.keys()].map(realPathOf));
  const busy = new Set<string>();
  for (const path of paths) {
    if (path !== null) for (const name of viewersAt(watch, path)) busy.add(name);
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
        if (viewersAt(watch, path).length > 0) settling.push(absorb(commonDir, watch));
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
  for (const [name, { gitDir }] of viewers) {
    state.set(`${name}\0index`, await fileState(join(gitDir, "index")));
  }
  return state;
}

async function snapshot(commonDir: string, viewers: Watch["viewers"]): Promise<Snapshot> {
  const state: Snapshot = new Map();
  await refDirectories(commonDir, state);
  for (const name of ["packed-refs", "FETCH_HEAD", join("reftable", "tables.list")]) {
    state.set(name, await fileState(join(commonDir, name)));
  }
  for (const [name, { gitDir }] of viewers) {
    const head = await readFile(join(gitDir, "HEAD"), "utf8").catch(() => "-");
    state.set(`${name}\0HEAD`, head.trim());
  }
  return volatileFiles(commonDir, viewers, state);
}

function enqueue(watch: { queue: Promise<void> }, task: () => Promise<void>): Promise<void> {
  watch.queue = watch.queue.then(task).catch(() => undefined);
  return watch.queue;
}

function dispose(subscription: Promise<ExperimentalHostWatchSubscription>): void {
  void subscription.then((live) => live.dispose()).catch(() => undefined);
}

function stop(commonDir: string, watch: Watch): void {
  if (watches.get(commonDir) !== watch) return;
  watches.delete(commonDir);
  if (watch.timer) clearTimeout(watch.timer);
  dispose(watch.subscription);
  pruneTrees();
}

function stopTree(real: string, tree: Tree): void {
  if (trees.get(real) !== tree) return;
  trees.delete(real);
  dispose(tree.subscription);
}

/** Working trees no live viewer reaches any more. */
function pruneTrees(): void {
  const wanted = new Set(
    [...watches.values()].flatMap((watch) => [...watch.viewers.values()].map((v) => v.real)),
  );
  for (const [real, tree] of trees) if (!wanted.has(real)) stopTree(real, tree);
}

/** Drops the viewers whose lease ran out, and the watch with the last of them. */
function expire(commonDir: string, watch: Watch, now = Date.now()): void {
  for (const [name, viewer] of watch.viewers) {
    if (viewer.until <= now) watch.viewers.delete(name);
  }
  if (watch.viewers.size === 0) return stop(commonDir, watch);
  pruneTrees();
  const next = Math.min(...[...watch.viewers.values()].map((viewer) => viewer.until));
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = setTimeout(() => expire(commonDir, watch), Math.max(0, next - now));
  watch.timer.unref?.();
}

async function emit(context: WatchContext, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  forget();
  await context.experimental_emitSignal("checkoutChanged", {
    paths: [...new Set(names)].slice(0, MAX_SIGNAL_PATHS),
  });
}

/** Compares the repository with the last baseline, and names the viewed checkouts it changed. */
async function check(commonDir: string, watch: Watch): Promise<void> {
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
  await emit(watch.context, shared ? [...watch.viewers.keys()] : [...touched]);
}

/**
 * A write of ours changed `commonDir`. Its processes' writes are never a
 * change on their own, so it tells the server about every checkout of the
 * repository it watches, and `also`, the checkout the write named.
 */
export function changed(commonDir: string, context: WatchContext, also: string): Promise<void> {
  const watch = watches.get(commonDir);
  if (!watch) return emit(context, [also]);
  return enqueue(watch, async () => {
    watch.seen = await snapshot(commonDir, watch.viewers);
    await emit(context, [also, ...watch.viewers.keys()]);
  });
}

function listen(commonDir: string, watch: Watch) {
  return (event: ExperimentalHostWatchEvent) => {
    if (watches.get(commonDir) !== watch) return;
    // A broken watch goes, and the next read arms a new one.
    if (event.kind === "watch-error") return stop(commonDir, watch);
    // A rescan means events were dropped, which the snapshot does not need.
    return enqueue(watch, () => check(commonDir, watch));
  };
}

/** The names of live viewers whose checkout is the working tree at `real`. */
function namesAt(real: string): string[] {
  const now = Date.now();
  return [...watches.values()].flatMap((watch) =>
    [...watch.viewers]
      .filter(([, viewer]) => viewer.real === real && viewer.until > now)
      .map(([name]) => name),
  );
}

/** Changed paths as the tree's own relative paths, without the Git directory's. */
function treePaths(real: string, event: Extract<ExperimentalHostWatchEvent, { kind: "changed" }>) {
  const paths = new Set<string>();
  for (const change of event.changes) {
    const path = isAbsolute(change.path) ? relative(real, change.path) : change.path;
    const slashed = path.split(sep).join("/");
    if (slashed === "" || slashed.startsWith("../") || slashed === "..") continue;
    if (slashed === ".git" || slashed.startsWith(".git/")) continue;
    paths.add(slashed);
  }
  return [...paths].slice(0, MAX_CHECKED_PATHS);
}

/** Which of `paths` git ignores. Any failure counts none as ignored, so a change still says so. */
async function ignoredOf(
  real: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  const result = await runGitCommand(real, ["check-ignore", "-z", "--stdin"], signal, {
    input: `${paths.join("\0")}\0`,
    own: false,
  }).catch(() => null);
  if (result?.code !== 0) return new Set();
  return new Set(result.stdout.split("\0").filter((path) => path !== ""));
}

/** Ignored directories at the top of the tree, which the watcher need not descend into. */
async function ignoredDirectories(real: string, signal: AbortSignal): Promise<string[]> {
  const result = await runGitCommand(
    real,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    signal,
    { own: false },
  ).catch(() => null);
  if (result?.code !== 0) return [];
  return result.stdout
    .split("\0")
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => entry.slice(0, -1))
    .slice(0, MAX_IGNORED_DIRECTORIES);
}

function listenTree(real: string, tree: Tree) {
  return (event: ExperimentalHostWatchEvent) => {
    if (trees.get(real) !== tree) return;
    if (event.kind === "watch-error") return stopTree(real, tree);
    return enqueue(tree, async () => {
      if (event.kind === "changed") {
        const paths = treePaths(real, event);
        if (paths.length === 0) return;
        const ignored = await ignoredOf(real, paths, AbortSignal.timeout(10_000));
        if (paths.every((path) => ignored.has(path))) return;
      }
      // A rescan dropped events, so something may have changed.
      await emit(tree.context, namesAt(real));
    });
  };
}

async function watchTree(real: string, context: WatchContext): Promise<void> {
  if (trees.has(real)) return;
  const tree: Tree = {
    subscription: Promise.resolve({ dispose: async () => undefined }),
    queue: Promise.resolve(),
    context,
  };
  trees.set(real, tree);
  const ignored = await ignoredDirectories(real, AbortSignal.timeout(10_000));
  if (trees.get(real) !== tree) return;
  try {
    tree.subscription = context.experimental_watch(
      {
        rootPath: real,
        // A linked worktree's `.git` is a file naming its Git directory; the main one's is the directory.
        ignoredPaths: [".git", ...ignored],
        debounceMs: DEBOUNCE_MS,
        maxWaitMs: MAX_WAIT_MS,
      },
      listenTree(real, tree),
    );
  } catch (error) {
    stopTree(real, tree);
    throw error;
  }
  tree.subscription.catch(() => stopTree(real, tree));
}

/** A checkout as the watch needs it: the server's name for it and its directories. */
export type Watched = { name: string; real: string; gitDir: string; commonDir: string };

/**
 * Keeps the checkout watched for WATCH_LEASE_MS more, and takes what the
 * read that just ended may have written as already seen. A watch that
 * cannot start leaves the checkout as it is: the server's poll still reads it.
 */
export async function keepWatching(checkout: Watched, context: WatchContext): Promise<void> {
  const { name, real, gitDir, commonDir } = checkout;
  let watch = watches.get(commonDir);
  if (!watch) {
    const created: Watch = {
      subscription: Promise.resolve({ dispose: async () => undefined }),
      viewers: new Map(),
      seen: new Map(),
      queue: Promise.resolve(),
      absorbing: null,
      timer: null,
      context,
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
        listen(commonDir, created),
      );
    } catch (error) {
      stop(commonDir, created);
      throw error;
    }
    created.subscription.catch(() => stop(commonDir, created));
    watch = created;
  }
  const current = watch;
  const known = current.viewers.get(name);
  current.viewers.set(name, { real, gitDir, until: Date.now() + WATCH_LEASE_MS });
  expire(commonDir, current);
  await Promise.all([
    watchTree(real, context),
    enqueue(current, async () => {
      const now = await snapshot(commonDir, current.viewers);
      // A new watch or viewer starts from what is there now. An old one only
      // takes what reads write, so a ref that moved during the read still wakes it.
      const fresh = current.seen.size === 0;
      for (const [key, value] of now) {
        const own = key.startsWith(`${name}\0`);
        if (fresh || volatile(key) || (own && known?.real !== real)) current.seen.set(key, value);
      }
    }),
  ]);
}

/** Renews the lease of a checkout already watched under `name`; false when none is. */
export function renew(name: string): boolean {
  for (const [commonDir, watch] of watches) {
    const viewer = watch.viewers.get(name);
    if (!viewer) continue;
    viewer.until = Date.now() + WATCH_LEASE_MS;
    expire(commonDir, watch);
    return true;
  }
  return false;
}

/** Stops every watch, for the entry's disposal. */
export function stopAll(): void {
  for (const [commonDir, watch] of watches) stop(commonDir, watch);
  for (const [real, tree] of trees) stopTree(real, tree);
}
